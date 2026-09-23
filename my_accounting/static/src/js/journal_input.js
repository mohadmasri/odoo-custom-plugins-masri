/** @odoo-module **/

import { Component, onWillStart, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

const SEPARATOR = "، ";
const SPLIT_RE = /[،,+]/;

/**
 * حقل اليومية في القيد (وفي قيود الصور): قائمة منسدلة باليوميات المستخدمة سابقاً،
 * مع إمكانية اختيار أكثر من يومية للقيد الواحد (مثل: ايرادات + رواتب) أو كتابة اسم
 * جديد. تُحفظ الأسماء في الحقل نفسه مفصولة بفاصلة، وتُحتسب في كل يومية منها.
 */
export class JournalInput extends Component {
    static template = "my_accounting.JournalInput";
    static props = { ...standardFieldProps };

    setup() {
        this.orm = useService("orm");
        this.inputRef = useRef("input");
        this.state = useState({ names: [], open: false, text: "", active: -1 });
        onWillStart(async () => {
            this.state.names = await this.orm.call("myaccounting.journal", "get_journal_names", []);
        });
    }

    get value() {
        return this.props.record.data[this.props.name] || "";
    }

    // اليوميات المختارة للقيد
    get selected() {
        return this.value.split(SPLIT_RE).map((part) => part.trim()).filter(Boolean);
    }

    get options() {
        const query = this.state.text.trim();
        const chosen = this.selected;
        return this.state.names.filter((name) =>
            !chosen.includes(name) && (!query || name.includes(query)));
    }

    get newName() {
        const text = this.state.text.trim();
        return text && !this.state.names.includes(text) && !this.selected.includes(text) ? text : "";
    }

    write(names) {
        this.props.record.update({ [this.props.name]: names.join(SEPARATOR) });
    }

    add(name) {
        const clean = name.trim();
        if (clean && !this.selected.includes(clean)) {
            this.write([...this.selected, clean]);
        }
        this.state.text = "";
        this.state.active = -1;
        this.inputRef.el?.focus();
    }

    remove(name) {
        this.write(this.selected.filter((item) => item !== name));
    }

    toggle() {
        if (this.state.open) {
            this.close();
        } else {
            this.state.text = "";
            this.state.open = true;
            this.inputRef.el.focus();
        }
    }

    onInput(ev) {
        this.state.text = ev.target.value;
        this.state.open = true;
        this.state.active = -1;
    }

    close() {
        this.state.open = false;
        this.state.active = -1;
    }

    // الخروج من الخانة: يُعتمد ما كُتب كيومية إضافية
    onBlur() {
        if (this.state.text.trim()) {
            this.add(this.state.text);
        }
        this.close();
    }

    onKeydown(ev) {
        const items = [...this.options, ...(this.newName ? [this.newName] : [])];
        if (ev.key === "ArrowDown") {
            ev.preventDefault();
            this.state.open = true;
            this.state.active = Math.min(this.state.active + 1, items.length - 1);
        } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            this.state.active = Math.max(this.state.active - 1, 0);
        } else if (ev.key === "Enter" && (this.state.open || this.state.text.trim())) {
            ev.preventDefault();
            ev.stopPropagation();
            this.add(this.state.active >= 0 ? items[this.state.active] : this.state.text);
        } else if (ev.key === "Backspace" && !this.state.text && this.selected.length) {
            this.remove(this.selected[this.selected.length - 1]);
        } else if (ev.key === "Escape" && this.state.open) {
            ev.stopPropagation();
            this.state.text = "";
            this.close();
        }
    }
}

registry.category("fields").add("myaccounting_journal", {
    component: JournalInput,
    displayName: "اليومية",
    supportedTypes: ["char"],
});
