/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";

/**
 * اتجاه صفحة الطباعة لشاشة واحدة فقط.
 *
 * قاعدة ‎@page‎ في ملفات الأنماط عامة على كل النظام، فآخر قاعدة تُحمَّل تفرض
 * اتجاهها على كل الشاشات (لهذا كان دفتر الأستاذ يُطبع عمودياً رغم أنه يحتاج
 * العرض). لذلك نحقن القاعدة هنا لحظة الطباعة من هذه الشاشة فقط، ثم نزيلها،
 * فلا تؤثر على أي طباعة أخرى.
 *
 * يعمل مع زر الطباعة في الشاشة ومع Ctrl+P معاً.
 */
export function usePrintPageSize(size, margin = "8mm") {
    let style = null;

    const enable = () => {
        if (style) {
            return;
        }
        style = document.createElement("style");
        style.textContent = `@page { size: ${size}; margin: ${margin}; }`;
        document.head.appendChild(style);
    };

    const disable = () => {
        if (style) {
            style.remove();
            style = null;
        }
    };

    onMounted(() => {
        window.addEventListener("beforeprint", enable);
        window.addEventListener("afterprint", disable);
    });
    onWillUnmount(() => {
        window.removeEventListener("beforeprint", enable);
        window.removeEventListener("afterprint", disable);
        disable();
    });

    return { enable, disable };
}
