/** @odoo-module **/

import { Component, onWillStart, useState, useRef } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { browser } from "@web/core/browser/browser";
import { applyTheme } from "./theme_service";

const SCHEME_COOKIE = "color_scheme";

export class MyAccountingSettings extends Component {
    static template = "my_accounting.Settings";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialogService = useService("dialog");
        this.fileInputRef = useRef("fileInput");
        this.state = useState({
            activeTab: "backup",
            rebootPassword: "",
            rebooting: false,
            restoring: false,
            journals: [],
            backup: null,
            savingBackup: false,
            runningBackup: false,
            theme: "odoo",
            themes: [],
        });
        onWillStart(() => Promise.all([this.loadJournals(), this.loadBackupConfig(), this.loadTheme()]));
    }

    setTab(tab) {
        this.state.activeTab = tab;
    }

    // ------------------------------------------------------------------
    // المظهر: الوضع (فاتح/داكن) ولون الواجهة
    // ------------------------------------------------------------------

    async loadTheme() {
        const result = await this.orm.call("myaccounting.theme", "get_theme", []);
        this.state.theme = result.theme;
        this.state.themes = result.themes;
    }

    get isDark() {
        return document.cookie.split(";").map((c) => c.trim()).includes(`${SCHEME_COOKIE}=dark`);
    }

    // الوضع الداكن يغيّر حزمة الأنماط التي يرسلها الخادم، فتلزم إعادة تحميل الصفحة
    setScheme(scheme) {
        if ((scheme === "dark") === this.isDark) {
            return;
        }
        document.cookie = `${SCHEME_COOKIE}=${scheme}; path=/; max-age=${60 * 60 * 24 * 365}`;
        browser.location.reload();
    }

    async setTheme(theme) {
        this.state.theme = theme;
        applyTheme(theme); // فوري، بلا إعادة تحميل
        await this.orm.call("myaccounting.theme", "set_theme", [theme]);
        this.notification.add("تم حفظ المظهر.", { type: "success" });
    }

    // ------------------------------------------------------------------
    // إعادة تشغيل النظام (تتطلب كلمة المرور في كل مرة)
    // ------------------------------------------------------------------

    askReboot() {
        if (!this.state.rebootPassword) {
            this.notification.add("أدخل كلمة المرور أولاً.", { type: "warning" });
            return;
        }
        this.dialogService.add(ConfirmationDialog, {
            title: "إعادة تشغيل النظام",
            body: "سيتوقف النظام عن العمل لدقيقة تقريباً وسيخرج كل المستخدمين المتصلين. " +
                  "تأكد من حفظ أي قيد مفتوح. هل تريد المتابعة؟",
            confirmLabel: "نعم، أعد التشغيل",
            confirmClass: "btn-danger",
            confirm: () => this.doReboot(),
            cancel: () => {},
        });
    }

    async doReboot() {
        const password = this.state.rebootPassword;
        this.state.rebooting = true;
        try {
            await this.orm.call("myaccounting.backup", "restart_server", [password]);
        } catch (error) {
            // كلمة مرور خاطئة أو صلاحية ناقصة: نُظهر السبب ونتوقف
            const message = (error.data && error.data.message) || error.message || "";
            if (message.includes("كلمة المرور") || message.includes("مدير النظام")) {
                this.state.rebooting = false;
                this.state.rebootPassword = "";
                this.notification.add(message, { type: "danger", sticky: true });
                return;
            }
            // انقطاع الاتصال متوقّع لأن الخادم يُعاد تشغيله أثناء الرد
        }
        this.state.rebootPassword = "";
        this.notification.add("جارٍ إعادة تشغيل النظام... ستُحدَّث الصفحة تلقائياً.", { type: "info" });
        await this.waitForServer();
    }

    // ننتظر عودة الخادم ثم نحدّث الصفحة
    async waitForServer() {
        const started = Date.now();
        while (Date.now() - started < 180000) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            try {
                const response = await fetch("/web/webclient/version_info", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {} }),
                });
                if (response.ok) {
                    window.location.reload();
                    return;
                }
            } catch (error) {
                // الخادم ما زال متوقفاً
            }
        }
        this.state.rebooting = false;
        this.notification.add(
            "لم يعد الخادم خلال 3 دقائق. حدّث الصفحة يدوياً أو راجع ملف server.log.",
            { type: "danger", sticky: true });
    }

    // ------------------------------------------------------------------
    // النسخ الاحتياطي التلقائي
    // ------------------------------------------------------------------

    async loadBackupConfig() {
        this.state.backup = await this.orm.call("myaccounting.backup", "get_auto_backup_config", []);
    }

    async saveBackupConfig() {
        const cfg = this.state.backup;
        this.state.savingBackup = true;
        try {
            this.state.backup = await this.orm.call("myaccounting.backup", "set_auto_backup_config",
                [cfg.enabled, cfg.directory, cfg.keep]);
            this.notification.add("تم حفظ إعدادات النسخ الاحتياطي التلقائي.", { type: "success" });
        } finally {
            this.state.savingBackup = false;
        }
    }

    async runBackupNow() {
        this.state.runningBackup = true;
        try {
            const result = await this.orm.call("myaccounting.backup", "run_auto_backup", [true]);
            if (result.success) {
                this.notification.add(
                    `تمت النسخة: ${result.filename} (${result.size_mb} ميغابايت)`, { type: "success" });
            } else {
                this.notification.add(result.error || "تعذّر إنشاء النسخة.", { type: "danger", sticky: true });
            }
            await this.loadBackupConfig();
        } finally {
            this.state.runningBackup = false;
        }
    }

    // ------------------------------------------------------------------
    // اليوميات: أي يومية تُكتب في قيد تظهر هنا تلقائياً
    // ------------------------------------------------------------------

    async loadJournals() {
        this.state.journals = await this.orm.call("myaccounting.journal", "get_journals", []);
    }

    async toggleJournalMenu(journal) {
        await this.orm.call("myaccounting.journal", "set_show_in_menu", [journal.id, !journal.show_in_menu]);
        await this.loadJournals();
        this.notification.add(
            "تم تحديث قائمة القوالب. حدّث الصفحة (F5) لتظهر في قائمة \"قيد جديد\".",
            { type: "success" }
        );
    }

    async moveJournal(journal, delta) {
        await this.orm.call("myaccounting.journal", "move_journal", [journal.id, delta]);
        await this.loadJournals();
    }

    isFirstJournal(journal) {
        return this.state.journals.indexOf(journal) === 0;
    }

    isLastJournal(journal) {
        return this.state.journals.indexOf(journal) === this.state.journals.length - 1;
    }

    downloadBackup() {
        window.open("/my_accounting/backup/download", "_blank");
    }

    triggerFileSelect() {
        this.fileInputRef.el.click();
    }

    onFileSelected(ev) {
        const file = ev.target.files[0];
        ev.target.value = "";
        if (!file) {
            return;
        }
        this.dialogService.add(ConfirmationDialog, {
            title: "استعادة نسخة احتياطية",
            body: `سيؤدي هذا إلى حذف جميع القيود والحسابات الحالية نهائياً، واستبدالها بمحتوى الملف "${file.name}". ` +
                  `لا يمكن التراجع عن هذه العملية. هل أنت متأكد من المتابعة؟`,
            confirmLabel: "نعم، احذف كل شيء واستعد النسخة",
            confirmClass: "btn-danger",
            confirm: () => this.restoreFromFile(file),
            cancel: () => {},
        });
    }

    async restoreFromFile(file) {
        this.state.restoring = true;
        try {
            const text = await file.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                throw new Error("الملف المحدد ليس بصيغة JSON صحيحة.");
            }
            const result = await this.orm.call("myaccounting.backup", "restore_backup_data", [data]);
            this.notification.add(
                `تمت الاستعادة بنجاح: ${result.accounts_count} حساب و ${result.moves_count} قيد.`,
                { type: "success", sticky: true }
            );
        } catch (e) {
            const msg = (e.data && e.data.message) || e.message || "تعذّرت عملية الاستعادة.";
            this.notification.add(msg, { type: "danger", sticky: true });
        } finally {
            this.state.restoring = false;
        }
    }
}

registry.category("actions").add("my_accounting.settings", MyAccountingSettings);
