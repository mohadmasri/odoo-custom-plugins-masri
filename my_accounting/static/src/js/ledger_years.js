/** @odoo-module **/

/**
 * السنوات التي فيها قيود فعلاً، الأحدث أولاً: مصدر موحّد لقائمة السنة
 * الظاهرة بجانب أزرار الأشهر في كل الشاشات.
 */
export async function loadLedgerYears(orm) {
    const years = await orm.call("myaccounting.move", "get_ledger_years", []);
    return years.length ? years : [new Date().getFullYear()];
}
