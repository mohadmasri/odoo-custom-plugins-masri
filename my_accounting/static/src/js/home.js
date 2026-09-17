/** @odoo-module **/

import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

export class MyAccountingHome extends Component {
    static template = "my_accounting.Home";
    static props = ["*"];

    setup() {
        this.actionService = useService("action");
        this.cards = [
            {
                title: "قيد جديد",
                desc: "إنشاء قيد محاسبي جديد مباشرة",
                icon: "fa-plus-circle",
                color: "#00A09D",
                action: () => this.actionService.doAction("my_accounting.action_myaccounting_move_new_form"),
            },
            {
                title: "القيود",
                desc: "استعراض والبحث في القيود المحاسبية",
                icon: "fa-list-alt",
                color: "#714B67",
                action: () => this.actionService.doAction("my_accounting.action_myaccounting_move_list"),
            },
            {
                title: "شجرة الحسابات",
                desc: "إدارة الحسابات وهيكلها الهرمي",
                icon: "fa-sitemap",
                color: "#017E84",
                action: () => this.actionService.doAction("my_accounting.action_myaccounting_account_tree"),
            },
            {
                title: "دفتر الأستاذ العام",
                desc: "تقرير شهري بحركات كل حساب",
                icon: "fa-book",
                color: "#F06050",
                action: () => this.actionService.doAction("my_accounting.action_myaccounting_general_ledger"),
            },
        ];
    }
}

registry.category("actions").add("my_accounting.home", MyAccountingHome);
