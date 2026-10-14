/** @odoo-module **/

import { registry } from "@web/core/registry";

/**
 * تنظيف الشريط العلوي مما لا يُستعمل في هذا النظام:
 * الإشعارات (المحادثة) والمهام (الأنشطة) تُنزع من سجل الشريط فلا تُبنى
 * أصلاً؛ أما عنوان التطبيق واسم الشركة فيُخفيان بالأنماط لأنهما جزء من
 * قالب الشريط نفسه (انظر navbar_trim.css).
 */
const systray = registry.category("systray");

for (const name of ["mail.messaging_menu", "mail.activity_menu"]) {
    if (systray.contains(name)) {
        systray.remove(name);
    }
}
