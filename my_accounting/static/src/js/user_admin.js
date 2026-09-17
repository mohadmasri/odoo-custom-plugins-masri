/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

const APP_LABELS = {
    myaccounting: "المحاسبة المخصصة",
    project: "المشروع",
    invoicing: "الفوترة",
    dashboard: "لوحات البيانات",
    discuss: "المناقشة",
    calendar: "التقويم",
    todo: "المهام",
    contacts: "جهات الاتصال",
};

// نافذة بسيطة لإنشاء مستخدم جديد (اسم مستخدم + كلمة مرور فقط، دون بريد
// إلكتروني)، أو لإعادة تسمية مستخدم، أو لتغيير كلمة مروره.
export class UserCredentialsDialog extends Component {
    static template = "my_accounting.UserCredentialsDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        mode: String, // 'create' | 'rename' | 'password'
        initialLogin: { type: String, optional: true },
        onConfirm: Function,
    };
    static defaultProps = { initialLogin: "" };

    setup() {
        this.notification = useService("notification");
        this.state = useState({
            login: this.props.initialLogin,
            password: "",
            saving: false,
        });
    }

    get title() {
        return { create: "مستخدم جديد", rename: "إعادة تسمية المستخدم", password: "تغيير كلمة المرور" }[this.props.mode];
    }

    async confirm() {
        this.state.saving = true;
        try {
            await this.props.onConfirm({ login: this.state.login, password: this.state.password });
            this.props.close();
        } catch (e) {
            this.notification.add(e.data && e.data.message ? e.data.message : "حدث خطأ.", { type: "danger" });
            this.state.saving = false;
        }
    }
}

export class UserAdmin extends Component {
    static template = "my_accounting.UserAdmin";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.dialogService = useService("dialog");
        this.notification = useService("notification");
        this.state = useState({
            users: [],
            apps: [],
            selectedUserId: null,
            loadingApps: false,
        });
        onWillStart(() => this.loadUsers());
    }

    async loadUsers() {
        this.state.users = await this.orm.call("myaccounting.user_admin", "get_users", []);
        if (this.state.selectedUserId && !this.state.users.find((u) => u.id === this.state.selectedUserId)) {
            this.state.selectedUserId = null;
            this.state.apps = [];
        }
    }

    get selectedUser() {
        return this.state.users.find((u) => u.id === this.state.selectedUserId) || null;
    }

    async selectUser(id) {
        this.state.selectedUserId = id;
        this.state.loadingApps = true;
        this.state.apps = await this.orm.call("myaccounting.user_admin", "get_apps_matrix", [id]);
        this.state.loadingApps = false;
    }

    appLabel(key) {
        return APP_LABELS[key] || key;
    }

    openCreateDialog() {
        this.dialogService.add(UserCredentialsDialog, {
            mode: "create",
            onConfirm: async ({ login, password }) => {
                const res = await this.orm.call("myaccounting.user_admin", "create_user", [login, password]);
                await this.loadUsers();
                this.notification.add(`تم إنشاء المستخدم "${login}".`, { type: "success" });
                if (res && res.id) {
                    await this.selectUser(res.id);
                }
            },
        });
    }

    openRenameDialog(user) {
        this.dialogService.add(UserCredentialsDialog, {
            mode: "rename",
            initialLogin: user.login,
            onConfirm: async ({ login }) => {
                await this.orm.call("myaccounting.user_admin", "rename_user", [user.id, login]);
                await this.loadUsers();
                this.notification.add("تم تحديث اسم المستخدم.", { type: "success" });
            },
        });
    }

    openPasswordDialog(user) {
        this.dialogService.add(UserCredentialsDialog, {
            mode: "password",
            onConfirm: async ({ password }) => {
                await this.orm.call("myaccounting.user_admin", "set_user_password", [user.id, password]);
                this.notification.add("تم تغيير كلمة المرور.", { type: "success" });
            },
        });
    }

    deleteUser(user) {
        this.dialogService.add(ConfirmationDialog, {
            title: "حذف المستخدم",
            body: `هل أنت متأكد من حذف المستخدم "${user.login}"؟ لا يمكن التراجع عن هذا الإجراء.`,
            confirmLabel: "حذف",
            confirmClass: "btn-danger",
            confirm: async () => {
                try {
                    await this.orm.call("myaccounting.user_admin", "delete_user", [user.id]);
                    await this.loadUsers();
                    this.notification.add("تم حذف المستخدم.", { type: "success" });
                } catch (e) {
                    this.notification.add(e.data && e.data.message ? e.data.message : "تعذّر حذف المستخدم.", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    async setPermission(appKey, level) {
        if (!this.state.selectedUserId) {
            return;
        }
        await this.orm.call("myaccounting.user_admin", "set_app_permission", [this.state.selectedUserId, appKey, level]);
        await this.selectUser(this.state.selectedUserId);
    }
}

registry.category("actions").add("my_accounting.user_admin", UserAdmin);
