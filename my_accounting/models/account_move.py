import re

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

LEDGER_MONTH_SELECTION = [
    ('1', '1 - يناير'), ('2', '2 - فبراير'), ('3', '3 - مارس'), ('4', '4 - أبريل'),
    ('5', '5 - مايو'), ('6', '6 - يونيو'), ('7', '7 - يوليو'), ('8', '8 - أغسطس'),
    ('9', '9 - سبتمبر'), ('10', '10 - أكتوبر'), ('11', '11 - نوفمبر'), ('12', '12 - ديسمبر'),
]


class MyAccountingMove(models.Model):
    _name = 'myaccounting.move'
    _description = 'قيد محاسبي'
    _order = 'date desc, id desc'
    _inherit = ['mail.thread', 'mail.activity.mixin']

    name = fields.Char(string='رقم القيد', required=True, copy=False, tracking=True,
                        default=lambda self: self._get_default_name())
    date = fields.Date(string='التاريخ', required=True, default=fields.Date.context_today, tracking=True)
    ref = fields.Char(string='المرجع')
    journal = fields.Char(string='اليومية', default='القيود اليدوية')

    ledger_month = fields.Selection(
        LEDGER_MONTH_SELECTION, string='شهر دفتر الأستاذ', required=True, tracking=True,
        default=lambda self: self._get_default_ledger_period()[1],
        help='الشهر الذي سيظهر فيه هذا القيد ضمن دفتر الأستاذ العام، بغض النظر عن تاريخ القيد أعلاه.',
    )
    ledger_year = fields.Integer(
        string='سنة دفتر الأستاذ', required=True, tracking=True,
        default=lambda self: self._get_default_ledger_period()[0],
    )
    ledger_period_label = fields.Char(string='الشهر المحاسبي', compute='_compute_ledger_period_label', store=True)

    state = fields.Selection([
        ('draft', 'مسودة'),
        ('posted', 'مرحّل'),
    ], string='الحالة', default='draft', tracking=True, copy=False)

    line_ids = fields.One2many('myaccounting.move.line', 'move_id', string='بنود القيد', copy=True)

    total_debit = fields.Float(string='إجمالي المدين', compute='_compute_totals', store=True, digits=(16, 3))
    total_credit = fields.Float(string='إجمالي الدائن', compute='_compute_totals', store=True, digits=(16, 3))
    is_balanced = fields.Boolean(string='متوازن', compute='_compute_totals', store=True)
    currency_id = fields.Many2one('res.currency', string='العملة',
                                   default=lambda self: self.env.company.currency_id)
    company_id = fields.Many2one('res.company', string='الشركة', default=lambda self: self.env.company)

    _name_company_uniq = models.Constraint(
        'unique(name, company_id)',
        'رقم القيد هذا مستخدم بالفعل، الرجاء اختيار رقم آخر.',
    )

    @api.model
    def _increment_name(self, name):
        """يزيد أول رقم يظهر في النص بمقدار 1 مع الحفاظ على باقي التنسيق.
        مثال: '1/10' تصبح '2/10'."""
        match = re.search(r'\d+', name)
        if not match:
            return f'{name}-1'
        num = str(int(match.group()) + 1).zfill(len(match.group()))
        return name[:match.start()] + num + name[match.end():]

    @api.model
    def _get_default_name(self):
        last_move = self.search([], order='id desc', limit=1)
        candidate = self._increment_name(last_move.name) if last_move and last_move.name else '1'
        guard = 0
        while guard < 1000 and self.search_count([('name', '=', candidate)]):
            candidate = self._increment_name(candidate)
            guard += 1
        return candidate

    @api.model
    def _get_default_ledger_period(self):
        last_move = self.search([], order='id desc', limit=1)
        if last_move and last_move.ledger_month and last_move.ledger_year:
            return last_move.ledger_year, last_move.ledger_month
        today = fields.Date.context_today(self)
        return today.year, str(today.month)

    @api.depends('ledger_month', 'ledger_year')
    def _compute_ledger_period_label(self):
        for move in self:
            if move.ledger_month and move.ledger_year:
                move.ledger_period_label = f"{int(move.ledger_month):02d}/{move.ledger_year}"
            else:
                move.ledger_period_label = ''

    @api.depends('line_ids.debit', 'line_ids.credit')
    def _compute_totals(self):
        for move in self:
            move.total_debit = sum(move.line_ids.mapped('debit'))
            move.total_credit = sum(move.line_ids.mapped('credit'))
            move.is_balanced = round(move.total_debit - move.total_credit, 3) == 0.0

    def action_post(self):
        for move in self:
            if not move.line_ids:
                raise UserError('لا يمكن ترحيل قيد بدون بنود.')
            if not move.is_balanced:
                raise UserError(
                    f'القيد غير متوازن: إجمالي المدين {move.total_debit} لا يساوي إجمالي الدائن {move.total_credit}.'
                )
            if not move.name:
                raise UserError('يجب إدخال رقم للقيد قبل الترحيل.')
            move.state = 'posted'

    def action_reset_to_draft(self):
        self.write({'state': 'draft'})

    def unlink(self):
        if not self.env.context.get('force_delete'):
            for move in self:
                if move.state == 'posted':
                    raise UserError('لا يمكن حذف قيد مرحّل. أعده إلى مسودة أولاً.')
        return super().unlink()

    @api.model
    def get_general_ledger_matrix(self, year, month):
        """دفتر الأستاذ العام: صف لكل قيد، وعمودا مدين/دائن لكل حساب رئيسي (جذري) دائماً،
        مع تجميع حركات أي حساب فرعي تحت حسابه الرئيسي.
        يعتمد التصنيف على شهر/سنة دفتر الأستاذ (ledger_month/ledger_year) للقيد
        وليس على تاريخه الفعلي، لدعم القيود التي تُسجَّل في شهر مختلف عن تاريخها."""
        moves = self.search([
            ('ledger_year', '=', int(year)),
            ('ledger_month', '=', str(int(month))),
            ('state', '=', 'posted'),
        ], order='date, id')

        accounts = self.env['myaccounting.account'].search([('parent_id', '=', False)], order='code')

        rows = []
        totals = {acc.id: {'debit': 0.0, 'credit': 0.0} for acc in accounts}
        grand_debit = 0.0
        grand_credit = 0.0

        for idx, move in enumerate(moves, start=1):
            amounts = {}
            for line in move.line_ids:
                root_id = int((line.account_id.parent_path or str(line.account_id.id)).split('/')[0])
                if root_id not in amounts:
                    amounts[root_id] = {'debit': 0.0, 'credit': 0.0}
                amounts[root_id]['debit'] += line.debit
                amounts[root_id]['credit'] += line.credit
                if root_id in totals:
                    totals[root_id]['debit'] += line.debit
                    totals[root_id]['credit'] += line.credit
            rows.append({
                'seq': idx,
                'move_id': move.id,
                'move_name': move.name,
                'ref': move.ref or '',
                'date': move.date and move.date.isoformat(),
                'total_debit': move.total_debit,
                'total_credit': move.total_credit,
                'amounts': amounts,
            })
            grand_debit += move.total_debit
            grand_credit += move.total_credit

        return {
            'accounts': [{'id': a.id, 'code': a.code, 'name': a.name} for a in accounts],
            'rows': rows,
            'totals': {a.id: totals[a.id] for a in accounts},
            'grand_debit': grand_debit,
            'grand_credit': grand_credit,
        }


class MyAccountingMoveLine(models.Model):
    _name = 'myaccounting.move.line'
    _description = 'بند قيد محاسبي'
    _order = 'id'

    move_id = fields.Many2one('myaccounting.move', string='القيد', required=True, ondelete='cascade')
    move_state = fields.Selection(related='move_id.state', string='حالة القيد', store=True)
    account_id = fields.Many2one('myaccounting.account', string='الحساب', required=True)
    account_label = fields.Char(string='اسم الحساب المعروض في القيد', compute='_compute_account_label')
    name = fields.Char(string='البيان')
    debit = fields.Float(string='مدين', default=0.0, digits=(16, 3))
    credit = fields.Float(string='دائن', default=0.0, digits=(16, 3))
    currency_id = fields.Many2one(related='move_id.currency_id', string='العملة', store=True)
    date = fields.Date(related='move_id.date', string='التاريخ', store=True)

    @api.depends('account_id', 'account_id.name', 'account_id.parent_id.name')
    def _compute_account_label(self):
        # عند تكرار اسم الحساب في أكثر من مكان في شجرة الحسابات (مثال: "الرواتب"
        # تحت أكثر من حساب أب)، نضيف اسم الحساب الأب لتمييزه، لكن فقط في عرض
        # بند القيد هذا، دون المساس باسم الحساب نفسه أو عرضه في أي مكان آخر.
        for line in self:
            account = line.account_id
            if not account:
                line.account_label = ''
                continue
            is_duplicate = bool(self.env['myaccounting.account'].search_count([
                ('name', '=', account.name),
                ('id', '!=', account.id),
            ]))
            if is_duplicate and account.parent_id:
                line.account_label = f"{account.name} / {account.parent_id.name}"
            else:
                line.account_label = account.name

    @api.constrains('debit', 'credit')
    def _check_debit_credit(self):
        for line in self:
            if line.debit < 0 or line.credit < 0:
                raise ValidationError('لا يمكن أن تكون قيمة المدين أو الدائن سالبة.')
            if line.debit and line.credit:
                raise ValidationError('لا يمكن أن يحتوي بند واحد على مدين ودائن في نفس الوقت.')
