/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { useService } from "@web/core/utils/hooks";

// نافذة استيراد قيود متعدّدة من ملف Excel: تحميل القالب، رفع الملف المعبّأ،
// ثم عرض ملخّص النتيجة (كم قيداً أُنشئ، وكم منها غير مكتمل، وأسماء الحسابات
// التي لم يُعثر عليها).
export class JournalImportDialog extends Component {
    static template = "my_accounting.JournalImportDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        onImported: { type: Function, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            fileName: "",
            fileData: null,
            importing: false,
            result: null,
        });
    }

    onFileChange(ev) {
        const file = ev.target.files && ev.target.files[0];
        this.state.result = null;
        if (!file) {
            this.state.fileName = "";
            this.state.fileData = null;
            return;
        }
        this.state.fileName = file.name;
        const reader = new FileReader();
        reader.onload = () => {
            // نأخذ الجزء التالي للفاصلة من data URL للحصول على base64 فقط
            this.state.fileData = reader.result.split(",")[1];
        };
        reader.readAsDataURL(file);
    }

    async runImport() {
        if (!this.state.fileData) {
            this.notification.add("اختر ملف Excel أولاً.", { type: "warning" });
            return;
        }
        this.state.importing = true;
        try {
            this.state.result = await this.orm.call(
                "myaccounting.move",
                "import_moves_from_xlsx",
                [this.state.fileData]
            );
            const { created, incomplete } = this.state.result;
            if (created) {
                this.notification.add(
                    incomplete
                        ? `تم استيراد ${created} قيد، منها ${incomplete} غير مكتمل.`
                        : `تم استيراد ${created} قيد بنجاح.`,
                    { type: incomplete ? "warning" : "success" }
                );
            } else {
                this.notification.add("لم يتم إنشاء أي قيد من الملف.", { type: "warning" });
            }
            if (this.props.onImported) {
                await this.props.onImported();
            }
        } catch (e) {
            this.notification.add(
                e.data && e.data.message ? e.data.message : "تعذّر استيراد الملف.",
                { type: "danger" }
            );
        }
        this.state.importing = false;
    }
}
