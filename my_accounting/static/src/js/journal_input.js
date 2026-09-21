/** @odoo-module **/

import { Component, onWillStart, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

/**
 * حقل اليومية في القيد (وفي قيود الصور): قائمة منسدلة باليوميات المستخدمة سابقاً،
 * مع إمكانية كتابة اسم جديد. السهم يعرض كل الخيارات، والكتابة تفلترها، والاسم غير
 * الموجود يظهر كخيار "إضافة يومية جديدة". الاسم الجديد يُسجَّل تلقائياً عند حفظ القيد،
 * فيظهر بعدها في قائمة القوالب تحت "قيد جديد" وفي إعدادات اليوميات.
 */
export class JournalInput extends Component {
    static template = "my_accounting.JournalInput";
    static props = { ...standardFieldProps };

    setup() {
        this.orm = useService("orm");
        this.inputRef = useRef("input");
        this.state = useState({ names: [], open: false, text: null, filter: false, active: -1 });
        onWillStart(async () => {
            this.state.names = await this.orm.call("myaccounting.journal", "get_journal_names", []);
        });
    }

    get value() {
        return this.props.record.data[this.props.name] || "";
    }

    // النص الظاهر في الخانة: ما يكتبه المستخدم أثناء الكتابة، وإلا القيمة المحفوظة
    get text() {
        return this.state.text ?? this.value;
    }

    get options() {
        const query = this.state.filter ? this.text.trim() : "";
        return query ? this.state.names.filter((name) => name.includes(query)) : this.state.names;
    }

    get newName() {
        const text = this.text.trim();
        return text && !this.state.names.includes(text) ? text : "";
    }

    toggle() {
        if (this.state.open) {
            this.close();
        } else {
            this.state.filter = false; // من السهم: كل الخيارات
            this.state.open = true;
            this.inputRef.el.focus();
        }
    }

    onInput(ev) {
        this.state.text = ev.target.value;
        this.state.filter = true;
        this.state.open = true;
        this.state.active = -1;
    }

    onFocus() {
        this.state.filter = false;
        this.state.open = true;
    }

    select(name) {
        this.props.record.update({ [this.props.name]: name.trim() });
        this.state.text = null;
        this.close();
    }

    close() {
        this.state.open = false;
        this.state.active = -1;
    }

    // عند الخروج من الخانة: يُعتمد ما كُتب (اسم موجود أو جديد)
    onBlur() {
        if (this.state.text !== null) {
            this.select(this.state.text);
        } else {
            this.close();
        }
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
        } else if (ev.key === "Enter" && this.state.open) {
            ev.preventDefault();
            ev.stopPropagation();
            this.select(this.state.active >= 0 ? items[this.state.active] : this.text);
        } else if (ev.key === "Escape" && this.state.open) {
            ev.stopPropagation();
            this.state.text = null;
            this.close();
        }
    }
}

registry.category("fields").add("myaccounting_journal", {
    component: JournalInput,
    displayName: "اليومية",
    supportedTypes: ["char"],
});
