/** @odoo-module **/

import { Component, reactive, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { patch } from "@web/core/utils/patch";
import { FormRenderer } from "@web/views/form/form_renderer";

const STORAGE_KEY = "my_accounting_chatter_mode";
const MODES = ["side", "bottom", "hidden"];

export const CHATTER_MODES = [
    { key: "side", label: "على الجانب", icon: "fa-columns", hint: "المحادثة في عمود يمين الشاشة (الوضع الافتراضي)" },
    { key: "bottom", label: "في الأسفل", icon: "fa-window-minimize", hint: "المحادثة أسفل النموذج بعرض الشاشة" },
    { key: "hidden", label: "إخفاء", icon: "fa-eye-slash", hint: "إخفاء المحادثة والمرفقات الجانبية تماماً" },
];

function storedMode() {
    try {
        const mode = localStorage.getItem(STORAGE_KEY);
        return MODES.includes(mode) ? mode : "side";
    } catch {
        return "side";
    }
}

// تفضيل مشترك بين كل الشاشات: أي تغيير يُعيد رسم النماذج المفتوحة فوراً
export const chatterPrefs = reactive({ mode: storedMode() });

export function setChatterMode(mode) {
    chatterPrefs.mode = MODES.includes(mode) ? mode : "side";
    try {
        localStorage.setItem(STORAGE_KEY, chatterPrefs.mode);
    } catch {
        // التخزين المحلي معطّل: يبقى الاختيار فعّالاً حتى إعادة التحميل
    }
}

/**
 * التحكم بمكان المحادثة (ChatterContainer) في كل النماذج.
 *
 * أودو يقرّر مكان المحادثة في mailLayout حسب عرض الشاشة ووجود مرفقات. نلتف
 * هنا على نتيجته فقط: نُنزلها إلى الأسفل، أو نلغيها، حسب اختيار المستخدم.
 */
patch(FormRenderer.prototype, {
    setup() {
        super.setup();
        this.maChatter = useState(chatterPrefs);
    },

    mailLayout(hasAttachmentContainer) {
        const layout = super.mailLayout(hasAttachmentContainer);
        if (layout === "NONE") {
            return layout; // لا محادثة أصلاً في هذا النموذج
        }
        if (this.maChatter.mode === "hidden") {
            return "NONE";
        }
        if (this.maChatter.mode === "bottom") {
            if (layout === "SIDE_CHATTER") {
                return "BOTTOM_CHATTER";
            }
            if (layout === "EXTERNAL_COMBO_XXL") {
                return "EXTERNAL_COMBO";
            }
        }
        return layout;
    },
});

/** زر في الشريط العلوي لاختيار مكان المحادثة أو إخفائها */
export class ChatterControl extends Component {
    static template = "my_accounting.ChatterControl";
    static components = { Dropdown, DropdownItem };
    static props = {};

    setup() {
        this.state = useState(chatterPrefs);
        this.modes = CHATTER_MODES;
    }

    get current() {
        return CHATTER_MODES.find((mode) => mode.key === this.state.mode) || CHATTER_MODES[0];
    }

    setMode(mode) {
        setChatterMode(mode);
    }
}

registry.category("systray").add(
    "my_accounting.chatter_control",
    { Component: ChatterControl },
    { sequence: 27 }
);
