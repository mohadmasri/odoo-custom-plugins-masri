/** @odoo-module **/

import { registry } from "@web/core/registry";

const STORAGE_KEY = "my_accounting_theme";

/** يضع اسم المظهر على وسم <html>، فتنطبق ألوانه من themes.css */
export function applyTheme(theme) {
    document.documentElement.dataset.maTheme = theme || "odoo";
    try {
        localStorage.setItem(STORAGE_KEY, theme || "odoo");
    } catch {
        // التخزين المحلي قد يكون معطّلاً: المظهر يُقرأ من الخادم في كل الأحوال
    }
}

/**
 * مظهر الواجهة: يُطبَّق فور فتح النظام من آخر اختيار محفوظ محلياً (بلا وميض)،
 * ثم يُعاد ضبطه من اختيار المستخدم المحفوظ على الخادم.
 */
export const themeService = {
    dependencies: ["orm"],
    async start(env, { orm }) {
        try {
            applyTheme(localStorage.getItem(STORAGE_KEY));
        } catch {
            applyTheme("odoo");
        }
        try {
            const { theme } = await orm.call("myaccounting.theme", "get_theme", []);
            applyTheme(theme);
        } catch {
            // بلا صلاحية أو الخادم غير متاح: يبقى المظهر المحفوظ محلياً
        }
        return { apply: applyTheme };
    },
};

registry.category("services").add("my_accounting.theme", themeService);
