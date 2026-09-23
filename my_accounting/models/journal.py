from odoo import api, fields, models

# اليومية الافتراضية للقيد الفارغ: لا تُعرض كقالب لأن "قيد فارغ" يؤدي نفس الغرض
DEFAULT_JOURNAL = 'القيود اليدوية'


class MyAccountingJournal(models.Model):
    _name = 'myaccounting.journal'
    _description = 'يومية (قالب قيد)'
    _order = 'sequence, id'

    name = fields.Char(string='اليومية', required=True)
    sequence = fields.Integer(string='الترتيب', default=10)
    show_in_menu = fields.Boolean(
        string='إظهار في قائمة "قيد جديد"', default=True,
        help='عند التفعيل تظهر هذه اليومية كقالب تحت قائمة "قيد جديد".')
    move_count = fields.Integer(string='عدد القيود', compute='_compute_move_count')

    _name_uniq = models.Constraint('unique(name)', 'اسم اليومية مستخدم بالفعل.')

    def _compute_move_count(self):
        # القيد قد يحمل أكثر من يومية، فيُحتسب في كل واحدة منها
        Move = self.env['myaccounting.move']
        counts = {}
        for move in Move.search([]):
            for name in Move.split_journals(move.journal):
                counts[name] = counts.get(name, 0) + 1
        for journal in self:
            journal.move_count = counts.get(journal.name, 0)

    @api.model
    def _sync_journals(self):
        """يبقي قائمة اليوميات مطابقة لليوميات المستخدمة فعلاً في القيود:
        يضيف الجديدة (مع تفعيلها في القائمة) ويحذف التي لم تعد مستخدمة."""
        Move = self.env['myaccounting.move']
        used = {name for move in Move.search([]) for name in Move.split_journals(move.journal)}
        existing = self.search([])
        by_name = {journal.name: journal for journal in existing}

        for journal in existing:
            if journal.name not in used:
                journal.unlink()

        last_sequence = max(existing.mapped('sequence') or [0])
        for name in sorted(used - set(by_name)):
            last_sequence += 10
            self.create({
                'name': name,
                'sequence': last_sequence,
                # اليومية الافتراضية لا تُعرض كقالب (تساوي "قيد فارغ")
                'show_in_menu': name != DEFAULT_JOURNAL,
            })

    # ------------------------------------------------------------------
    # تُستخدم من صفحة الإعدادات ومن حقل اليومية في القيد
    # ------------------------------------------------------------------

    @api.model
    def get_journal_names(self):
        return self.search([]).mapped('name')

    @api.model
    def get_journals(self):
        self._sync_journals()
        return [{
            'id': journal.id,
            'name': journal.name,
            'sequence': journal.sequence,
            'show_in_menu': journal.show_in_menu,
            'move_count': journal.move_count,
        } for journal in self.search([])]

    @api.model
    def set_show_in_menu(self, journal_id, value):
        self.browse(journal_id).show_in_menu = bool(value)
        self.env['myaccounting.move']._sync_journal_template_menus()
        return True

    @api.model
    def move_journal(self, journal_id, delta):
        """يحرّك اليومية خطوة واحدة في ترتيب القائمة (delta = -1 لأعلى، 1 لأسفل)."""
        journals = list(self.search([]))
        journal = self.browse(journal_id)
        if journal not in journals:
            return False
        index = journals.index(journal)
        target = index + delta
        if target < 0 or target >= len(journals):
            return False
        journals.insert(target, journals.pop(index))
        for position, item in enumerate(journals, start=1):
            if item.sequence != position:
                item.sequence = position
        self.env['myaccounting.move']._sync_journal_template_menus()
        return True
