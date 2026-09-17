/** @odoo-module **/

import { useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import {
    Many2OneField,
    m2oSupportedOptions,
    m2oSupportedTypes,
    extractM2OFieldProps,
} from "@web/views/fields/many2one/many2one_field";
import { computeM2OProps, Many2One } from "@web/views/fields/many2one/many2one";

// حقل "الحساب" في بند القيد: نفس البحث/الاختيار/الإنشاء المعتادة تعمل بشكل طبيعي
// بالكامل، مع إضافتين:
// 1. عندما يكون اسم الحساب المختار مكرراً في أكثر من مكان بشجرة الحسابات، يُستبدل
//    النص المعروض فقط بـ "اسم الحساب / اسم الحساب الأب" (دون المساس بالاسم الفعلي).
// 2. عند اختيار حساب رئيسي له حسابات فرعية، يظهر "فلتر" صغير باسم ذلك الحساب مع
//    علامة X لإزالته؛ وطالما الفلتر مُفعّل، يقتصر البحث/القائمة الافتراضية على
//    الحسابات الفرعية التابعة له فقط، لتمييز الأسماء المتكررة عبر أكثر من فرع
//    (مثال: اختيار "مصاريف المشاريع" ثم كتابة "الرواتب" يختار "الرواتب" التابعة
//    لها تحديداً).
export class AccountLineSelectorField extends Many2OneField {
    static template = "my_accounting.AccountLineSelector";
    static components = { Many2One };

    setup() {
        super.setup();
        this.orm = useService("orm");
        this.scopeState = useState({ id: null, name: "" });
    }

    get m2oProps() {
        const props = computeM2OProps(this.props);

        const label = this.props.record.data.account_label;
        if (props.value && label) {
            props.value = { ...props.value, display_name: label };
        }

        // ما دام القيد لا يزال مسودة، نمنع النقر على البند من فتح صفحة الحساب
        // (كان هذا يمنع الصف من الدخول في وضع التعديل عند النقر عليه)، فيصبح
        // بإمكان المستخدم النقر على البند والتعديل عليه مباشرة كالمعتاد. بعد
        // ترحيل القيد، نعيد تفعيل الرابط للانتقال إلى الحساب عند النقر.
        if (this.props.record.data.move_state !== 'posted') {
            props.canOpen = false;
        }

        if (this.scopeState.id) {
            const scopeId = this.scopeState.id;
            const baseDomain = props.domain;
            props.domain = () => {
                const base = baseDomain ? baseDomain() : [];
                return [...base, ["parent_id", "=", scopeId]];
            };
        }

        const baseUpdate = props.update;
        props.update = (value, options) => {
            this.onAccountSelected(value);
            return baseUpdate(value, options);
        };

        return props;
    }

    async onAccountSelected(value) {
        if (!value || !value.id) {
            this.clearScope();
            return;
        }
        const [account] = await this.orm.read("myaccounting.account", [value.id], ["parent_id"]);
        if (!account || account.parent_id) {
            // حساب فرعي: أبقِ الفلتر الحالي كما هو (إن وُجد) دون تغيير.
            return;
        }
        const childCount = await this.orm.searchCount("myaccounting.account", [
            ["parent_id", "=", value.id],
        ]);
        if (childCount > 0) {
            this.scopeState.id = value.id;
            this.scopeState.name = value.display_name;
        } else {
            this.clearScope();
        }
    }

    clearScope() {
        this.scopeState.id = null;
        this.scopeState.name = "";
    }
}

registry.category("fields").add("myaccounting_account_selector", {
    component: AccountLineSelectorField,
    extractProps: extractM2OFieldProps,
    supportedOptions: m2oSupportedOptions,
    supportedTypes: m2oSupportedTypes,
});
