import { isDesktopApplication } from '@/utils';
import { PrivilegesManager } from '@/services/privilegesManager';
import template from '%/directives/account-menu.pug';
import { protocolManager } from 'snjs';
import {
  STRING_ACCOUNT_MENU_UNCHECK_MERGE,
  STRING_SIGN_OUT_CONFIRMATION,
  STRING_ERROR_DECRYPTING_IMPORT,
  STRING_E2E_ENABLED,
  STRING_LOCAL_ENC_ENABLED,
  STRING_ENC_NOT_ENABLED,
  STRING_IMPORT_SUCCESS,
  STRING_REMOVE_PASSCODE_CONFIRMATION,
  STRING_REMOVE_PASSCODE_OFFLINE_ADDENDUM,
  STRING_NON_MATCHING_PASSCODES,
  STRING_NON_MATCHING_PASSWORDS,
  STRING_INVALID_IMPORT_FILE,
  STRING_GENERATING_LOGIN_KEYS,
  STRING_GENERATING_REGISTER_KEYS,
  StringImportError
} from '@/strings';

const ELEMENT_ID_IMPORT_PASSWORD_INPUT = 'import-password-request';

class AccountMenuCtrl {
  /* @ngInject */
  constructor(
    $scope,
    $rootScope,
    $timeout,
    alertManager,
    archiveManager,
    appVersion,
    authManager,
    modelManager,
    passcodeManager,
    privilegesManager,
    storageManager,
    syncManager,
  ) {
    this.$scope = $scope;
    this.$rootScope = $rootScope;
    this.$timeout = $timeout;
    this.alertManager = alertManager;
    this.archiveManager = archiveManager;
    this.authManager = authManager;
    this.modelManager = modelManager;
    this.passcodeManager = passcodeManager;
    this.privilegesManager = privilegesManager;
    this.storageManager = storageManager;
    this.syncManager = syncManager;

    this.appVersion = 'v' + (window.electronAppVersion || appVersion);
    this.user = this.authManager.user;
    this.canAddPasscode = !this.authManager.isEphemeralSession();
    this.syncStatus = this.syncManager.syncStatus;
    this.user = this.authManager.user;
    this.passcodeAutoLockOptions = this.passcodeManager.getAutoLockIntervalOptions();
    this.formData = {
      mergeLocal: true,
      ephemeral: false
    };
    this.archiveFormData = {
      encrypted: this.encryptedBackupsAvailable() ? true : false
    };
    this.syncManager.getServerURL().then((url) => {
      this.server = url;
      this.formData.url = url;
    })
    this.authManager.checkForSecurityUpdate().then((available) => {
      this.securityUpdateAvailable = available;
    })
    this.reloadAutoLockInterval();
  }

  close() {
    this.$timeout(() => {
      this.closeFunction()();
    })
  }

  encryptedBackupsAvailable() {
    return this.authManager.user || this.passcodeManager.hasPasscode();
  }

  submitMfaForm() {
    const params = {
      [this.formData.mfa.payload.mfa_key]: this.formData.userMfaCode
    };
    this.login(params);
  }

  submitAuthForm() {
    if(!this.formData.email || !this.formData.user_password) {
      return;
    }
    if(this.formData.showLogin) {
      this.login();
    } else {
      this.register();
    }
  }

  async login(extraParams) {
    /** Prevent a timed sync from occuring while signing in. */
    this.syncManager.lockSyncing();
    this.formData.status = STRING_GENERATING_LOGIN_KEYS;
    this.formData.authenticating = true;
    const response = await this.authManager.login(
      this.formData.url,
      this.formData.email,
      this.formData.user_password,
      this.formData.ephemeral,
      this.formData.strictSignin,
      extraParams
    );
    const hasError = !response || response.error;
    if(!hasError) {
      await this.onAuthSuccess();
      this.syncManager.unlockSyncing();
      this.syncManager.sync({performIntegrityCheck: true});
      return;
    }
    this.syncManager.unlockSyncing();
    this.formData.status = null;
    const error = response
      ? response.error
      : {message: "An unknown error occured."}

    if(error.tag === 'mfa-required' || error.tag === 'mfa-invalid') {
      this.formData.showLogin = false;
      this.formData.mfa = error;
    } else {
      this.formData.showLogin = true;
      this.formData.mfa = null;
      if(error.message) {
        this.alertManager.alert({
          text: error.message
        });
      }
    }
    this.formData.authenticating = false;
  }

  async register() {
    const confirmation = this.formData.password_conf;
    if(confirmation !== this.formData.user_password) {
      this.alertManager.alert({
        text: STRING_NON_MATCHING_PASSWORDS
      });
      return;
    }
    this.formData.confirmPassword = false;
    this.formData.status = STRING_GENERATING_REGISTER_KEYS;
    this.formData.authenticating = true;
    const response = await this.authManager.register(
      this.formData.url,
      this.formData.email,
      this.formData.user_password,
      this.formData.ephemeral
    )
    if(!response || response.error) {
      this.formData.status = null;
      const error = response
        ? response.error
        : {message: "An unknown error occured."};
      this.formData.authenticating = false;
      this.alertManager.alert({
        text: error.message
      });
    } else {
      await this.onAuthSuccess();
      this.syncManager.sync();
    }
  }

  mergeLocalChanged() {
    if(!this.formData.mergeLocal) {
      this.alertManager.confirm({
        text: STRING_ACCOUNT_MENU_UNCHECK_MERGE,
        destructive: true,
        onCancel: () => {
          this.formData.mergeLocal = true;
        }
      })
    }
  }

  async onAuthSuccess() {
    if(this.formData.mergeLocal) {
      this.$rootScope.$broadcast('major-data-change');
      await this.clearDatabaseAndRewriteAllItems({alternateUuids: true});
    } else {
      this.modelManager.removeAllItemsFromMemory();
      await this.storageManager.clearAllModels();
    }
    this.formData.authenticating = false;
    this.syncManager.refreshErroredItems();
    this.close();
  }

  openPasswordWizard(type) {
    this.close();
    this.authManager.presentPasswordWizard(type);
  }

  async openPrivilegesModal() {
    this.close();
    const run = () => {
      this.$timeout(() => {
        this.privilegesManager.presentPrivilegesManagementModal();
      })
    }
    const needsPrivilege = await this.privilegesManager.actionRequiresPrivilege(
      PrivilegesManager.ActionManagePrivileges
    );
    if(needsPrivilege) {
      this.privilegesManager.presentPrivilegesModal(
        PrivilegesManager.ActionManagePrivileges,
        () => {
          run();
        }
      );
    } else {
      run();
    }
  }

  /**
   * Allows IndexedDB unencrypted logs to be deleted
   * `clearAllModels` will remove data from backing store,
   * but not from working memory See:
   * https://github.com/standardnotes/desktop/issues/131
   */
  async clearDatabaseAndRewriteAllItems({alternateUuids} = {}) {
    await this.storageManager.clearAllModels();
    await this.syncManager.markAllItemsDirtyAndSaveOffline(alternateUuids)
  }

  destroyLocalData() {
    this.alertManager.confirm({
      text: STRING_SIGN_OUT_CONFIRMATION,
      destructive: true,
      onConfirm: async () => {
        await this.authManager.signout(true);
        window.location.reload();
      }
    })
  }

  async submitImportPassword() {
    await this.performImport(
      this.importData.data,
      this.importData.password
    );
  }

  async readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const data = JSON.parse(e.target.result);
          resolve(data);
        } catch (e) {
          this.alertManager.alert({
            text: STRING_INVALID_IMPORT_FILE
          });
        }
      }

      reader.readAsText(file);
    })
  }

  /** Called by template. */
  async importFileSelected(files) {
    const run = async () => {
      this.importData = {};
      const file = files[0];
      const data = await this.readFile(file);
      if(!data) {
        return;
      }
      if(data.auth_params) {
        this.importData.requestPassword = true;
        this.importData.data = data;
        const element = document.getElementById(
          ELEMENT_ID_IMPORT_PASSWORD_INPUT
        );
        if(element) {
          element.scrollIntoView(false);
        }
      } else {
        await this.performImport(data, null);
      }
    }

    const needsPrivilege = await this.privilegesManager.actionRequiresPrivilege(
      PrivilegesManager.ActionManageBackups
    );
    if(needsPrivilege) {
      this.privilegesManager.presentPrivilegesModal(
        PrivilegesManager.ActionManageBackups,
        () => {
          this.$timeout(run);
        }
      );
    } else {
      this.$timeout(run);
    }
  }

  async performImport(data, password) {
    this.importData.loading = true;
    const errorCount = await this.importJSONData(data, password);
    this.importData.loading = false;
    this.importData = null;
    if(errorCount > 0) {
      const message = StringImportError({errorCount: errorCount})
      this.alertManager.alert({
        text: message
      });
    } else {
      this.alertManager.alert({
        text: STRING_IMPORT_SUCCESS
      })
    }
  }

  async importJSONData(data, password) {
    let errorCount = 0;
    if(data.auth_params) {
      const keys = await protocolManager.computeEncryptionKeysForUser(
        password,
        data.auth_params
      );
      try {
        const throws = false;
        await protocolManager.decryptMultipleItems(data.items, keys, throws);
        const items = [];
        for(const item of data.items) {
          item.enc_item_key = null;
          item.auth_hash = null;
          if(item.errorDecrypting) {
            errorCount++;
          } else {
            items.push(item);
          }
        }
        data.items = items;
      } catch (e) {
        this.alertManager.alert({
          text: STRING_ERROR_DECRYPTING_IMPORT
        });
        return;
      }
    }

    const items = await this.modelManager.importItems(data.items);
    for(const item of items) {
      /**
       * Don't want to activate any components during import process in
       * case of exceptions breaking up the import proccess
       */
      if(item.content_type === 'SN|Component') {
        item.active = false;
      }
    }

    this.syncManager.sync();
    return errorCount;
  }

  async downloadDataArchive() {
    this.archiveManager.downloadBackup(this.archiveFormData.encrypted);
  }

  notesAndTagsCount() {
    return this.modelManager.allItemsMatchingTypes([
      'Note',
      'Tag'
    ]).length;
  }

  encryptionStatusForNotes() {
    const length = this.notesAndTagsCount();
    return length + "/" + length + " notes and tags encrypted";
  }

  encryptionEnabled() {
    return this.passcodeManager.hasPasscode() || !this.authManager.offline();
  }

  encryptionSource() {
    if(!this.authManager.offline()) {
      return "Account keys";
    } else if(this.passcodeManager.hasPasscode()) {
      return "Local Passcode";
    } else {
      return null;
    }
  }

  encryptionStatusString() {
    if(!this.authManager.offline()) {
      return STRING_E2E_ENABLED;
    } else if(this.passcodeManager.hasPasscode()) {
      return STRING_LOCAL_ENC_ENABLED;
    } else {
      return STRING_ENC_NOT_ENABLED;
    }
  }

  async reloadAutoLockInterval() {
    const interval = await this.passcodeManager.getAutoLockInterval();
    this.selectedAutoLockInterval = interval;
  }

  async selectAutoLockInterval(interval) {
    const run = async () => {
      await this.passcodeManager.setAutoLockInterval(interval);
      this.$timeout(() => {
        this.reloadAutoLockInterval();
      });
    }
    const needsPrivilege = await this.privilegesManager.actionRequiresPrivilege(
      PrivilegesManager.ActionManagePasscode
    );
    if(needsPrivilege) {
      this.privilegesManager.presentPrivilegesModal(
        PrivilegesManager.ActionManagePasscode,
        () => {
          run();
        }
      );
    } else {
      run();
    }
  }

  hasPasscode() {
    return this.passcodeManager.hasPasscode();
  }

  addPasscodeClicked() {
    this.formData.showPasscodeForm = true;
  }

  submitPasscodeForm() {
    const passcode = this.formData.passcode;
    if(passcode !== this.formData.confirmPasscode) {
      this.alertManager.alert({
        text: STRING_NON_MATCHING_PASSCODES
      });
      return;
    }
    const func = this.formData.changingPasscode
      ? this.passcodeManager.changePasscode.bind(this.passcodeManager)
      : this.passcodeManager.setPasscode.bind(this.passcodeManager);
    func(passcode, () => {
      this.$timeout(async () => {
        this.formData.passcode = null;
        this.formData.confirmPasscode = null;
        this.formData.showPasscodeForm = false;
        if(await this.authManager.offline()) {
          this.$rootScope.$broadcast('major-data-change');
          this.clearDatabaseAndRewriteAllItems();
        }
      })
    })
  }

  async changePasscodePressed() {
    const run = () => {
      this.formData.changingPasscode = true;
      this.addPasscodeClicked();
    }
    const needsPrivilege = await this.privilegesManager.actionRequiresPrivilege(
      PrivilegesManager.ActionManagePasscode
    );
    if(needsPrivilege) {
      this.privilegesManager.presentPrivilegesModal(
        PrivilegesManager.ActionManagePasscode,
        () => {
          this.$timeout(run);
        }
      );
    } else {
      this.$timeout(run);
    }
  }

  async removePasscodePressed() {
    const run = () => {
      const signedIn = !this.authManager.offline();
      const message = STRING_REMOVE_PASSCODE_CONFIRMATION;
      if(!signedIn) {
        message += STRING_REMOVE_PASSCODE_OFFLINE_ADDENDUM;
      }
      this.alertManager.confirm({
        text: message,
        destructive: true,
        onConfirm: () => {
          this.passcodeManager.clearPasscode();
          if(this.authManager.offline()) {
            this.syncManager.markAllItemsDirtyAndSaveOffline();
          }
        }
      })
    }
    const needsPrivilege = await this.privilegesManager.actionRequiresPrivilege(
      PrivilegesManager.ActionManagePasscode
    );
    if(needsPrivilege) {
      this.privilegesManager.presentPrivilegesModal(
        PrivilegesManager.ActionManagePasscode,
        () => {
          this.$timeout(run);
        }
      );
    } else {
      this.$timeout(run);
    }
  }

  isDesktopApplication() {
    return isDesktopApplication();
  }
}

export class AccountMenu {
  constructor() {
    this.restrict = 'E';
    this.template = template;
    this.controller = AccountMenuCtrl;
    this.controllerAs = 'ctrl';
    this.bindToController = true;
    this.scope = {
      closeFunction: '&'
    };
  }
}
