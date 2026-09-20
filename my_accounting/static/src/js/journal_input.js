/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

/**
 * حقل اليومية في القيد: قائمة باليوميات المستخدمة سابقاً مع إمكانية كتابة
 * اسم جديد. الاسم الجديد يُسجَّل تلقائياً عند حفظ القيد، فيظهر بعدها في
 * قائمة القوالب تحت "قيد جديد" وفي إعدادات اليوميات.
 */
export class JournalInput extends Component {
    static template = "my_accounting.JournalInput";
    static props = { ...standardFieldProps };

    setup() {
        this.orm = useService("orm");
        this.state = useState({ names: [] });
        this.datalistId = `o_myaccounting_journals_${Math.random().toString(36).slice(2)}`;
        onWillStart(async () => {
            this.state.names = await this.orm.call("myaccounting.journal", "get_journal_names", []);
        });
    }

    get value() {
        return this.props.record.data[this.props.name] || "";
    }

    onChange(ev) {
        this.props.record.update({ [this.props.name]: ev.target.value.trim() });
    }
}

registry.category("fields").add("myaccounting_journal", {
    component: JournalInput,
    displayName: "اليومية",
    supportedTypes: ["char"],
});
