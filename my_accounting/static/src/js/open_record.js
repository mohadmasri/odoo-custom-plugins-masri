/** @odoo-module **/

import { router } from "@web/core/browser/router";

/**
 * فتح السجلات من شاشاتنا: نقرة عادية تفتحه في نفس الشاشة، والنقر بالزر
 * الأوسط (أو Ctrl + نقر) يفتحه في تبويب جديد من المتصفح.
 *
 * تُستخدم مع الموجّه t-custom-click في القوالب، فهو يعطي (ev, isMiddleClick).
 */

/** رابط السجل داخل النظام، مثل /odoo/myaccounting.move/853 */
export function recordHref(resModel, resId) {
    return router.stateToUrl({ model: resModel, resId });
}

/**
 * @param {object} actionService خدمة الإجراءات في الشاشة
 * @param {string} resModel النموذج، مثل myaccounting.move
 * @param {number} resId رقم السجل
 * @param {boolean} isMiddleClick نقرة الزر الأوسط أو Ctrl + نقر
 * @param {object} [options] خيارات doAction (مثل resIds للتنقل بالأسهم)،
 *   و context يُمرَّر إلى الإجراء نفسه
 */
export function openRecord(actionService, resModel, resId, isMiddleClick, options = {}) {
    if (!resId) {
        return;
    }
    if (isMiddleClick) {
        window.open(recordHref(resModel, resId), "_blank", "noopener");
        return;
    }
    const { context, ...actionOptions } = options;
    actionService.doAction(
        {
            type: "ir.actions.act_window",
            res_model: resModel,
            res_id: resId,
            views: [[false, "form"]],
            target: "current",
            ...(context ? { context } : {}),
        },
        actionOptions
    );
}

// شاشاتنا التي تفتح سجلات بالنقر: نمنع فيها دائرة التمرير التلقائي التي يظهرها
// المتصفح عند ضغط الزر الأوسط، فيبقى الأثر الوحيد هو فتح التبويب الجديد.
const CLICKABLE_PAGES = [
    ".o_move_list",
    ".o_general_ledger",
    ".o_customers_page",
    ".o_account_tree_page",
    ".o_trial_balance",
    ".o_photo_page",
    ".o_photo_batch",
    ".o_account_movements_panel",
].join(",");

document.addEventListener("mousedown", (ev) => {
    if (ev.button === 1 && ev.target instanceof Element && ev.target.closest(CLICKABLE_PAGES)) {
        ev.preventDefault();
    }
});
