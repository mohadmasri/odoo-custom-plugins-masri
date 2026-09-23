/** @odoo-module **/

import { useRef } from "@odoo/owl";
import { useExternalListener } from "@odoo/owl";
import { patch } from "@web/core/utils/patch";
import { Pager } from "@web/core/pager/pager";

// عناصر تكتب فيها: السهم فيها يحرّك مؤشّر الكتابة أو يختار من الاقتراحات
const TYPING_SELECTOR = [
    "input",
    "textarea",
    "select",
    "[contenteditable]",
    ".o-autocomplete",
    ".note-editable",
    ".o_pager",
].join(",");

/**
 * التنقل بين السجلات بسهم لوحة المفاتيح، أينما وُجد زرّا "السابق/التالي"
 * (القيود، الحسابات، العملاء، وأي شاشة أخرى فيها مؤشّر تنقّل).
 *
 * السهم يعمل ما دام التركيز خارج حقول الكتابة؛ وداخل بنود القيد يُستخدم
 * Shift + سهم للتنقل بين البنود وحقولها (انظر line_hotkeys.js).
 *
 * السهم يتبع اتجاه الشاشة: في الواجهة من اليسار لليمين يفتح السهم الأيمن
 * السجل التالي، وفي الواجهة من اليمين لليسار يفعل ذلك السهم الأيسر، أي
 * دائماً باتجاه السهم المرسوم على الزر نفسه.
 */
patch(Pager.prototype, {
    setup() {
        super.setup();
        this.maRoot = useRef("maRoot");
        // مرحلة الالتقاط: نسبق تنقّل الجداول بالأسهم داخل الشاشة
        useExternalListener(window, "keydown", this.onMaArrowKey.bind(this), { capture: true });
    },

    /** هل يجوز لهذا المؤشّر أن يلتقط الأسهم الآن؟ */
    maCanNavigate(target) {
        const el = this.maRoot.el;
        // مؤشّرات الجداول داخل النماذج (بنود القيد مثلاً) لا تلتقط الأسهم
        if (!el || !this.props.withAccessKey) {
            return false;
        }
        // مؤشّر مخفي (شاشة أخرى في الخلفية)
        if (!el.offsetParent) {
            return false;
        }
        // نافذة منبثقة مفتوحة: يعمل مؤشّرها هي فقط
        const dialog = document.querySelector(".modal.show, .o_dialog");
        if (dialog && !dialog.contains(el)) {
            return false;
        }
        // المستخدم يكتب في حقل أو يختار من قائمة اقتراحات: الأسهم له
        if (document.querySelector(".o-autocomplete--dropdown-menu, .dropdown-menu.show")) {
            return false;
        }
        return !(target instanceof Element) || !target.closest(TYPING_SELECTOR);
    },

    onMaArrowKey(ev) {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") {
            return;
        }
        if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) {
            return;
        }
        if (this.state.isDisabled || this.state.isEditing || this.isSinglePage) {
            return;
        }
        if (!this.maCanNavigate(ev.target)) {
            return;
        }
        const rtl = getComputedStyle(this.maRoot.el).direction === "rtl";
        const forward = rtl ? ev.key === "ArrowLeft" : ev.key === "ArrowRight";
        ev.preventDefault();
        ev.stopPropagation();
        this.navigate(forward ? 1 : -1);
    },
});
