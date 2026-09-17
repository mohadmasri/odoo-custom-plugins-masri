/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { useService } from "@web/core/utils/hooks";

export class BulkAccountDialog extends Component {
    static template = "my_accounting.BulkAccountDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        defaultParentId: { type: [Number, Boolean], optional: true },
        onCreated: { type: Function, optional: true },
    };
    static defaultProps = {
        defaultParentId: false,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            parentId: this.props.defaultParentId,
            accounts: [],
            namesText: "",
            saving: false,
        });
        onWillStart(() => this.loadAccounts());
    }

    async loadAccounts() {
        this.state.accounts = await this.orm.searchRead(
            "myaccounting.account",
            [["parent_id", "=", false]],
            ["display_name"],
            { order: "code_path" }
        );
    }

    onParentChange(ev) {
        const val = ev.target.value;
        this.state.parentId = val ? parseInt(val, 10) : false;
    }

    get namesList() {
        return this.state.namesText
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }

    async confirm() {
        const names = this.namesList;
        if (!names.length) {
            this.notification.add("الرجاء إدخال اسم حساب واحد على الأقل.", { type: "warning" });
            return;
        }
        this.state.saving = true;
        try {
            await this.orm.call("myaccounting.account", "bulk_create_accounts", [names, this.state.parentId]);
            this.notification.add(`تم إنشاء ${names.length} حساب بنجاح.`, { type: "success" });
            if (this.props.onCreated) {
                await this.props.onCreated();
            }
            this.props.close();
        } catch (e) {
            this.notification.add(e.data && e.data.message ? e.data.message : "تعذّر إنشاء الحسابات.", { type: "danger" });
            this.state.saving = false;
        }
    }
}
