"""تعريف الكتل الجاهزة: قالب يحوّل صفاً واحداً من البيانات إلى بنود قيد.

الكتلة تتكوّن من خانات مبالغ يملؤها المستخدم (المبلغ، العمولة، النسبة...)
وبنود تُبنى منها بصيغ حسابية بسيطة، فيمكن بناء أي كتلة متكررة في المكتب
بلا تعديل برمجي. الصيغ تُحسب في المتصفّح وقت الاستعمال، وهذا النموذج
يحفظ التعريف فقط.
"""
from odoo import api, fields, models
from odoo.exceptions import UserError

# الكتل التي يبدأ بها النظام، وتُبنى مرة واحدة عند أول فتح للصفحة.
# 'code' مفتاح الحساب الافتراضي، و'' يعني أن الحساب يُسأل عنه عند الاستعمال.
DEFAULT_BLOCKS = [
    {
        'name': 'فاتورة', 'icon': 'fa-file-text-o', 'sequence': 10,
        'hint': 'ذمم الجهة مديناً بالإجمالي، الإيراد دائناً بالصافي، والضريبة دائنة.',
        'fields': [('amount', 'المبلغ قبل الضريبة', 0.0), ('rate', 'نسبة الضريبة %', 16.0)],
        'lines': [
            ('', '', 'حساب الجهة (الذمم)', 'debit', 'amount + amount * rate / 100', False),
            ('', '401', '', 'credit', 'amount', False),
            ('', '201', '', 'credit', 'amount * rate / 100', True),
        ],
    },
    {
        'name': 'فاتورة شاملة الضريبة', 'icon': 'fa-file-text-o', 'sequence': 20,
        'hint': 'المبلغ المكتوب على الفاتورة شامل الضريبة، فتُستخرج منه.',
        'fields': [('amount', 'المبلغ شامل الضريبة', 0.0), ('rate', 'نسبة الضريبة %', 16.0)],
        'lines': [
            ('', '', 'حساب الجهة (الذمم)', 'debit', 'amount', False),
            ('', '401', '', 'credit', 'amount / (1 + rate / 100)', False),
            ('', '201', '', 'credit', 'amount - amount / (1 + rate / 100)', True),
        ],
    },
    {
        'name': 'فاتورة معفاة', 'icon': 'fa-file-o', 'sequence': 30,
        'hint': 'بلا ضريبة، ويبقى بند الضريبة ظاهراً بصفر.',
        'fields': [('amount', 'المبلغ', 0.0)],
        'lines': [
            ('', '', 'حساب الجهة (الذمم)', 'debit', 'amount', False),
            ('', '401', '', 'credit', 'amount', False),
            ('', '201', '', 'credit', '0', True),
        ],
    },
    {
        'name': 'كفالة', 'icon': 'fa-shield', 'sequence': 40,
        'hint': 'الكفالة والعمولة مدينتان، والبنك دائن بالمجموع.',
        'fields': [('amount', 'مبلغ الكفالة', 0.0), ('commission', 'العمولة', 0.0)],
        'lines': [
            ('', '652', '', 'debit', 'amount', False),
            ('', '760', '', 'debit', 'commission', False),
            ('', '101', '', 'credit', 'amount + commission', False),
        ],
    },
    {
        'name': 'قبض', 'icon': 'fa-money', 'sequence': 50,
        'hint': 'ذمم الجهة دائنة بالإجمالي، البنك مدين بالصافي، والطوابع مدينة.',
        'fields': [('amount', 'المبلغ الإجمالي', 0.0), ('fee', 'الطوابع', 0.0)],
        'lines': [
            ('', '', 'حساب الجهة (الذمم)', 'credit', 'amount', False),
            ('', '101', '', 'debit', 'amount - fee', False),
            ('طوابع', '', 'حساب الطوابع', 'debit', 'fee', False),
        ],
    },
]


class MyAccountingBlock(models.Model):
    _name = 'myaccounting.block'
    _description = 'كتلة جاهزة لبنود القيد'
    _order = 'sequence, id'

    name = fields.Char(string='اسم الكتلة', required=True)
    icon = fields.Char(string='الأيقونة', default='fa-th-large')
    hint = fields.Char(string='الشرح')
    sequence = fields.Integer(string='الترتيب', default=10)
    active = fields.Boolean(string='مفعّلة', default=True)
    field_ids = fields.One2many('myaccounting.block.field', 'block_id',
                                string='خانات المبالغ', copy=True)
    line_ids = fields.One2many('myaccounting.block.line', 'block_id',
                               string='البنود', copy=True)

    # ------------------------------------------------------------------
    # القراءة: تخدم نافذة الكتل وصفحة إدارتها معاً
    # ------------------------------------------------------------------

    @api.model
    def get_blocks(self, with_accounts=True):
        self._seed_defaults()
        blocks = self.search([])
        data = {'blocks': [block._payload() for block in blocks]}
        if with_accounts:
            accounts = self.env['myaccounting.account'].search([], order='code_path')
            data['accounts'] = [{
                'id': acc.id, 'code': acc.code or '', 'name': acc.name,
                'label': f'{acc.code} - {acc.name}' if acc.code else acc.name,
            } for acc in accounts]
        return data

    @api.model
    def _account_label(self, account):
        if not account:
            return ''
        return f'{account.code} - {account.name}' if account.code else account.name

    def _payload(self):
        self.ensure_one()
        return {
            'id': self.id,
            'name': self.name,
            'icon': self.icon or 'fa-th-large',
            'hint': self.hint or '',
            'sequence': self.sequence,
            'active': self.active,
            'fields': [{
                'id': field.id, 'key': field.key, 'label': field.label,
                'default_value': field.default_value, 'sequence': field.sequence,
            } for field in self.field_ids],
            'lines': [{
                'id': line.id, 'label': line.label or '',
                'account_id': line.account_id.id or False,
                'account_label': self._account_label(line.account_id),
                'ask_account': line.ask_account,
                'account_prompt': line.account_prompt or '',
                'side': line.side, 'formula': line.formula or '0',
                'zero_visible': line.zero_visible, 'sequence': line.sequence,
            } for line in self.line_ids],
        }

    # ------------------------------------------------------------------
    # الكتابة من صفحة الإعدادات
    # ------------------------------------------------------------------

    @api.model
    def save_block(self, values):
        """ينشئ كتلة أو يحدّثها بخاناتها وبنودها دفعة واحدة."""
        block_id = values.get('id')
        header = {
            'name': (values.get('name') or '').strip(),
            'icon': (values.get('icon') or 'fa-th-large').strip(),
            'hint': (values.get('hint') or '').strip(),
            'sequence': int(values.get('sequence') or 10),
            'active': bool(values.get('active', True)),
        }
        if not header['name']:
            raise UserError('اكتب اسماً للكتلة.')
        lines = values.get('lines') or []
        if not lines:
            raise UserError('الكتلة بلا بنود، أضف بنداً واحداً على الأقل.')
        keys = [(field.get('key') or '').strip() for field in (values.get('fields') or [])]
        if len(set(keys)) != len(keys):
            raise UserError('مفاتيح خانات المبالغ مكرّرة، وكل مفتاح يجب أن يكون فريداً.')
        block = self.browse(int(block_id)) if block_id else self.create(header)
        if block_id:
            block.write(header)
            block.field_ids.unlink()
            block.line_ids.unlink()
        self.env['myaccounting.block.field'].create([{
            'block_id': block.id,
            'sequence': index * 10,
            'key': (field.get('key') or '').strip(),
            'label': (field.get('label') or '').strip() or (field.get('key') or ''),
            'default_value': float(field.get('default_value') or 0.0),
        } for index, field in enumerate(values.get('fields') or [])])
        self.env['myaccounting.block.line'].create([{
            'block_id': block.id,
            'sequence': index * 10,
            'label': (line.get('label') or '').strip(),
            'account_id': int(line['account_id']) if line.get('account_id') else False,
            'ask_account': bool(line.get('ask_account')),
            'account_prompt': (line.get('account_prompt') or '').strip(),
            'side': line.get('side') == 'credit' and 'credit' or 'debit',
            'formula': (line.get('formula') or '0').strip() or '0',
            'zero_visible': bool(line.get('zero_visible')),
        } for index, line in enumerate(lines)])
        return block._payload()

    @api.model
    def delete_block(self, block_id):
        self.browse(int(block_id)).unlink()
        return True

    @api.model
    def duplicate_block(self, block_id):
        source = self.browse(int(block_id))
        copy = source.copy({'name': f'{source.name} (نسخة)'})
        return copy._payload()

    # ------------------------------------------------------------------
    # الكتل الأولى
    # ------------------------------------------------------------------

    @api.model
    def _seed_defaults(self):
        """يبني الكتل المعتادة مرة واحدة، عند أول استعمال فقط."""
        param = self.env['ir.config_parameter'].sudo()
        if param.get_param('my_accounting.blocks_seeded') or self.search_count([]):
            param.set_param('my_accounting.blocks_seeded', '1')
            return
        Account = self.env['myaccounting.account']
        for spec in DEFAULT_BLOCKS:
            block = self.create({
                'name': spec['name'], 'icon': spec['icon'],
                'hint': spec['hint'], 'sequence': spec['sequence'],
            })
            self.env['myaccounting.block.field'].create([{
                'block_id': block.id, 'sequence': index * 10,
                'key': key, 'label': label, 'default_value': default,
            } for index, (key, label, default) in enumerate(spec['fields'])])
            lines = []
            for index, (label, code, prompt, side, formula, zero) in enumerate(spec['lines']):
                account = Account.search([('code', '=', code)], limit=1) if code else Account
                lines.append({
                    'block_id': block.id, 'sequence': index * 10, 'label': label,
                    'account_id': account.id or False,
                    'ask_account': not account,
                    'account_prompt': prompt,
                    'side': side, 'formula': formula, 'zero_visible': zero,
                })
            self.env['myaccounting.block.line'].create(lines)
        param.set_param('my_accounting.blocks_seeded', '1')


class MyAccountingBlockField(models.Model):
    _name = 'myaccounting.block.field'
    _description = 'خانة مبلغ في كتلة جاهزة'
    _order = 'sequence, id'

    block_id = fields.Many2one('myaccounting.block', string='الكتلة',
                               required=True, ondelete='cascade', index=True)
    sequence = fields.Integer(string='الترتيب', default=10)
    key = fields.Char(string='المفتاح', required=True,
                      help='الاسم الذي يُكتب في صيغ البنود، بالإنجليزية بلا مسافات.')
    label = fields.Char(string='العنوان', required=True)
    default_value = fields.Float(string='القيمة الافتراضية', digits=(16, 3))


class MyAccountingBlockLine(models.Model):
    _name = 'myaccounting.block.line'
    _description = 'بند في كتلة جاهزة'
    _order = 'sequence, id'

    block_id = fields.Many2one('myaccounting.block', string='الكتلة',
                               required=True, ondelete='cascade', index=True)
    sequence = fields.Integer(string='الترتيب', default=10)
    label = fields.Char(string='بيان البند',
                        help='اتركه فارغاً ليأخذ البند بيان الكتلة المكتوب عند الاستعمال.')
    account_id = fields.Many2one('myaccounting.account', string='الحساب')
    ask_account = fields.Boolean(string='يُسأل عن الحساب',
                                 help='الحساب يتغيّر في كل مرة (العميل مثلاً)، فيُطلب عند الاستعمال.')
    account_prompt = fields.Char(string='عنوان سؤال الحساب')
    side = fields.Selection([('debit', 'مدين'), ('credit', 'دائن')],
                            string='الجانب', required=True, default='debit')
    formula = fields.Char(string='الصيغة', required=True, default='0',
                          help='حساب بسيط على مفاتيح الخانات: amount + commission')
    zero_visible = fields.Boolean(string='يظهر بصفر',
                                  help='البند الذي مبلغه صفر يبقى ظاهراً (كبند ضريبة فاتورة معفاة).')
