/** @odoo-module **/

import { Component, onWillStart, useState, useRef } from "@odoo/owl";
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
            journals: [],
        });
        onWillStart(() => this.loadJournals());
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
