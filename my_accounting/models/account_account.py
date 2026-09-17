from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError


class MyAccountingAccount(models.Model):
    _name = 'myaccounting.account'
    _description = 'حساب محاسبي (شجرة الحسابات)'
    _order = 'code_path'
    _parent_store = True
    _rec_name = 'display_name'
    _inherit = ['mail.thread', 'mail.activity.mixin']

    name = fields.Char(string='اسم الحساب', required=True, tracking=True)
    code = fields.Char(
        string='رمز الحساب', required=True, copy=False, readonly=True, tracking=True,
        default=lambda self: self.env['ir.sequence'].next_by_code('myaccounting.account') or '/',
    )
    display_name = fields.Char(string='الاسم المعروض', compute='_compute_display_name', store=True)

    parent_id = fields.Many2one('myaccounting.account', string='الحساب الأب', ondelete='restrict')
    parent_path = fields.Char(index=True)
    child_ids = fields.One2many('myaccounting.account', 'parent_id', string='الحسابات الفرعية')

    code_path = fields.Char(compute='_compute_code_path', store=True, recursive=True)
    level = fields.Integer(compute='_compute_level', store=True)
    name_tree = fields.Char(compute='_compute_name_tree')

    note = fields.Text(string='ملاحظات')
    active = fields.Boolean(string='نشط', default=True)
    is_essential = fields.Boolean(string='أساسي', default=False, tracking=True,
                                   help='الحسابات الأساسية محمية من الحذف؛ ألغِ تفعيل هذا الخيار أولاً إذا أردت حذف الحساب.')

    reviewed = fields.Boolean(string='تمت المراجعة', default=False, tracking=True)
    reviewed_by = fields.Many2one('res.users', string='راجعه', readonly=True)
    reviewed_date = fields.Datetime(string='تاريخ المراجعة', readonly=True)

    move_line_ids = fields.One2many('myaccounting.move.line', 'account_id', string='حركات القيود')
    balance = fields.Float(string='الرصيد (المرحّل)', compute='_compute_balance', digits=(16, 3))
    currency_id = fields.Many2one('res.currency', string='العملة',
                                   default=lambda self: self.env.company.currency_id)

    company_id = fields.Many2one('res.company', string='الشركة', default=lambda self: self.env.company)

    _code_company_uniq = models.Constraint(
        'unique(code, company_id)',
        'رمز الحساب يجب أن يكون فريداً ضمن نفس الشركة!',
    )

    @api.depends('code', 'name', 'level')
    def _compute_display_name(self):
        for account in self:
            indent = ' ' * 4 * (account.level or 0)
            base = f"[{account.code}] {account.name}" if account.code else account.name
            account.display_name = f"{indent}{base}"

    @api.depends('code', 'parent_id.code_path')
    def _compute_code_path(self):
        for account in self:
            if account.parent_id:
                account.code_path = f"{account.parent_id.code_path}/{account.code or ''}"
            else:
                account.code_path = account.code or ''

    @api.depends('code_path')
    def _compute_level(self):
        for account in self:
            account.level = (account.code_path or '').count('/')

    @api.depends('name', 'level')
    def _compute_name_tree(self):
        for account in self:
            indent = ' ' * 4 * (account.level or 0)
            prefix = f"{indent}↳ " if account.level else ''
            account.name_tree = f"{prefix}{account.name or ''}"

    def _compute_balance(self):
        for account in self:
            lines = self.env['myaccounting.move.line'].search([
                ('account_id', '=', account.id),
                ('move_id.state', '=', 'posted'),
            ])
            account.balance = sum(lines.mapped('debit')) - sum(lines.mapped('credit'))

    @api.constrains('parent_id')
    def _check_parent_recursion(self):
        if not self._check_recursion():
            raise ValidationError('لا يمكن أن يكون الحساب أباً لنفسه (حلقة في شجرة الحسابات)!')

    def unlink(self):
        essential = self.filtered('is_essential') if not self.env.context.get('force_delete') else self.browse()
        if essential:
            names = '، '.join(essential.mapped('name'))
            raise UserError(
                f'لا يمكن حذف الحسابات التالية لأنها مُعلَّمة كـ "أساسي": {names}.\n'
                'ألغِ تفعيل خيار "أساسي" من داخل الحساب أولاً إذا أردت حذفه.'
            )
        return super().unlink()

    def name_search(self, name='', domain=None, operator='ilike', limit=100):
        # عند فتح القائمة دون كتابة أي نص، نعرض الحسابات الرئيسية فقط لتسهيل
        # الاختيار السريع. أما عند الكتابة الفعلية للبحث (أو عبر "البحث عن
        # المزيد" التي لا تمر من هنا أصلاً)، فتُعرض كل الحسابات دون قيد.
        # نتجاوز هذا التقييد إن كان المستدعي قد مرّر أصلاً شرطاً على parent_id
        # (مثال: فلتر "الحساب الرئيسي" في مربع إضافة البند)، حتى لا يتعارض
        # الشرطان معاً ويُظهر نتيجة فارغة.
        domain = list(domain or [])
        has_parent_filter = any(
            isinstance(d, (list, tuple)) and len(d) == 3 and d[0] == 'parent_id'
            for d in domain
        )
        if not name and not has_parent_filter:
            domain = domain + [('parent_id', '=', False)]
        return super().name_search(name=name, domain=domain, operator=operator, limit=limit)

    def action_review(self):
        self.write({
            'reviewed': True,
            'reviewed_by': self.env.user.id,
            'reviewed_date': fields.Datetime.now(),
        })

    def _get_statement_lines(self, date_from=False, date_to=False, line_ids=None):
        self.ensure_one()
        if line_ids is not None:
            lines = self.env['myaccounting.move.line'].browse(line_ids).exists()
            return lines.sorted(key=lambda line: (line.date or fields.Date.today(), line.id))
        domain = [('account_id', 'child_of', self.id)]
        if date_from:
            domain.append(('date', '>=', date_from))
        if date_to:
            domain.append(('date', '<=', date_to))
        return self.env['myaccounting.move.line'].search(domain, order='date, id')

    def action_reset_review(self):
        self.write({
            'reviewed': False,
            'reviewed_by': False,
            'reviewed_date': False,
        })

    def action_create_child_account(self):
        """يفتح نموذج إنشاء حساب جديد، مع تعيين هذا الحساب أباً افتراضياً له
        (قابل للتعديل من داخل النموذج)."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'إنشاء حساب',
            'res_model': 'myaccounting.account',
            'view_mode': 'form',
            'target': 'current',
            'context': {'default_parent_id': self.id},
        }

    @api.model
    def bulk_create_accounts(self, names, parent_id=False):
        """إنشاء عدة حسابات دفعة واحدة تحت نفس الحساب الأب."""
        vals_list = []
        for name in names:
            name = (name or '').strip()
            if name:
                vals_list.append({'name': name, 'parent_id': parent_id or False})
        if not vals_list:
            return []
        return self.create(vals_list).ids
