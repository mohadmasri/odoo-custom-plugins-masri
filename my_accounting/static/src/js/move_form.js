/** @odoo-module **/

import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { formView } from "@web/views/form/form_view";
import { FormController } from "@web/views/form/form_controller";

export class MyAccountingMoveFormController extends FormController {
    setup() {
        super.setup();
        this.moveListActionService = useService("action");
    }

    async discard() {
        // نعيد تنفيذ نفس منطق discard() الأساسي، لكن بدل الاعتماد على
        // historyBack() (التي قد تُرجع المستخدم إلى تطبيق افتراضي عشوائي
        // إن لم يوجد قيد سابق في مسار التنقل)، نوجّهه دائماً وبشكل صريح
        // إلى صفحة "القيود" عند إهمال قيد جديد لم يُحفظ بعد.
        if (this.props.discardRecord) {
            this.props.discardRecord(this.model.root);
            return;
        }
        const wasNew = this.model.root.isNew;
        await this.model.root.discard();
        if (this.props.onDiscard) {
            this.props.onDiscard(this.model.root);
        }
        if (this.env.inDialog) {
            await this.env.dialogData.close();
        } else if (wasNew) {
            await this.moveListActionService.doAction("my_accounting.action_myaccounting_move_list", {
                clearBreadcrumbs: true,
            });
        }
    }
}

registry.category("views").add("myaccounting_move_form", {
    ...formView,
    Controller: MyAccountingMoveFormController,
});
