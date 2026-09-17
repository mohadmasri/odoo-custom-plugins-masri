/** @odoo-module **/

import { Component, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { computeAppsAndMenuItems } from "@web/webclient/menus/menu_helpers";

export class AppLauncher extends Component {
    static template = "my_accounting.AppLauncher";
    static props = ["*"];

    setup() {
        this.menuService = useService("menu");
        this.apps = [];
        onWillStart(() => {
            const tree = this.menuService.getMenuAsTree("root");
            const { apps } = computeAppsAndMenuItems(tree);
            this.apps = apps;
        });
    }

    openApp(app, ev) {
        if (ev) {
            ev.preventDefault();
        }
        this.menuService.selectMenu(app.id);
    }
}

registry.category("actions").add("my_accounting.app_launcher", AppLauncher);
