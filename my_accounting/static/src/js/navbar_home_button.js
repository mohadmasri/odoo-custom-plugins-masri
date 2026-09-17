/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { NavBar } from "@web/webclient/navbar/navbar";

// زر "الصفحة الرئيسية" بجانب أيقونة التطبيقات في الشريط العلوي، ينقل مباشرة
// إلى صفحة "التطبيقات الفعالة" الخاصة بتطبيق المحاسبة المخصص.
patch(NavBar.prototype, {
    onMyAccountingHomeClick() {
        this.actionService.doAction("my_accounting.action_app_launcher", {
            clearBreadcrumbs: true,
        });
    },
});
