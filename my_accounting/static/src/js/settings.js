/** @odoo-module **/

import { Component, useState, useRef } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

export class MyAccountingSettings extends Component {
    static template = "my_accounting.Settings";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialogService = useService("dialog");
        this.fileInputRef = useRef("fileInput");
        this.state = useState({
            restoring: false,
        });
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
