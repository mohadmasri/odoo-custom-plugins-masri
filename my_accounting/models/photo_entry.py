"""إضافة قيد عبر صورة (BETA).

1. يصوّر المستخدم مستندات القيود من الهاتف (كل صورة على حدة)، فتُحفظ بانتظار القراءة.
2. من الحاسوب يختار صورة ويقرؤها بـ Claude أو Gemini؛ ويمكن إعادة القراءة بأي نموذج
   أكثر من مرة (عند ضغط الخدمة مثلاً). القراءة تعبّئ بنود "قيد الصورة" للمراجعة.
   القراءة تعمل في الخلفية (مهمة مجدولة)، فتستمر حتى لو غادر المستخدم الصفحة، وتُحفظ
   خطواتها على السجل ليعرضها شريط التقدم عند العودة.
3. بعد المراجعة يُرحَّل، فيُنشأ قيد محاسبي عادي مرحّل، وتُحذف الصورة من النظام.
قيود الصور نموذج منفصل، فلا تظهر في شاشات القيود ولا في أي تقرير قبل الترحيل.
"""
import base64
import io
import json
import logging
import re
from datetime import timedelta

import requests
from PIL import Image, ImageOps

from odoo import api, fields, models
from odoo.exceptions import AccessError, UserError

from .account_move import LEDGER_MONTH_SELECTION, normalize_digits

_logger = logging.getLogger(__name__)

API_KEY_PARAM = 'my_accounting.anthropic_api_key'
GEMINI_KEY_PARAM = 'my_accounting.gemini_api_key'
GEMINI_MODEL_PARAM = 'my_accounting.gemini_model'
CLAUDE_MODEL = 'claude-opus-5'
GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash'
GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
PROVIDERS = [('claude', 'Claude'), ('gemini', 'Gemini')]
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # حد Claude للصورة الواحدة
STALE_READ_MINUTES = 10  # قراءة "جارية" أقدم من هذا تعني أنها انقطعت (إعادة تشغيل الخادم مثلاً)
RETRY_FIRST_SECONDS = 30  # الانتظار قبل أول إعادة محاولة، ويتضاعف بعدها
RETRY_MAX_SECONDS = 300


class TransientReadError(UserError):
    """فشل مؤقت (ضغط الخدمة، حد الاستخدام، انقطاع الاتصال...): تُعاد المحاولة تلقائياً
    في القراءة الجماعية. الأخطاء الأخرى (مفتاح خاطئ، نموذج غير موجود...) دائمة."""

NUMBER_OR_NULL = {'anyOf': [{'type': 'number'}, {'type': 'null'}]}
STRING_OR_NULL = {'anyOf': [{'type': 'string'}, {'type': 'null'}]}
VOUCHER_SCHEMA = {
    'type': 'object',
    'properties': {
        'number': STRING_OR_NULL,
        'date': STRING_OR_NULL,
        'notes': {'type': 'string'},
        'lines': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'debit': NUMBER_OR_NULL,
                    'credit': NUMBER_OR_NULL,
                    'account_code': STRING_OR_NULL,
                    'account_text': {'type': 'string'},
                    'label': {'type': 'string'},
                    'uncertain': {'type': 'boolean'},
                    'uncertain_reason': {'type': 'string'},
                },
                'required': ['debit', 'credit', 'account_code', 'account_text', 'label',
                             'uncertain', 'uncertain_reason'],
                'additionalProperties': False,
            },
        },
    },
    'required': ['number', 'date', 'notes', 'lines'],
    'additionalProperties': False,
}


def gemini_schema(schema):
    """Gemini يقبل القيمة الفارغة بصيغة "type": ["number", "null"] بدل anyOf."""
    if isinstance(schema, dict):
        if 'anyOf' in schema:
            return {'type': [option['type'] for option in schema['anyOf']]}
        return {key: gemini_schema(value) for key, value in schema.items()}
    if isinstance(schema, list):
        return [gemini_schema(item) for item in schema]
    return schema


SYSTEM_PROMPT = """أنت محاسب يقرأ صورة "مستند قيد" مكتوب بخط اليد بالعربية لمكتب هندسي في الأردن، ويحوّله إلى بيانات منظمة.

شكل المستند المعتاد:
- في الأعلى: التاريخ والرقم (مثل 5/8 أي القيد 5 من الشهر 8).
- جدول أعمدته من اليمين: "من" (المدين) و"الى" (الدائن)، وكل منهما مقسوم إلى دينار وفلس، ثم "الحساب المدين" ثم "الحساب الدائن" ثم "البيان"، وفي الأسفل "المجموع".
- الأرقام غالباً بالأرقام العربية المشرقية (٠١٢٣٤٥٦٧٨٩). الدينار = 1000 فلس، فالمبلغ = الدينار + الفلس/1000 (مثال: 890 دينار و650 فلس = 890.650).
- قد يحتوي صف واحد على حساب مدين ومبلغ في "من" وحساب دائن ومبلغ في "الى" معاً.
- قد يكون البيان مكتوباً في صف ويخص الصفوف التي بعده، وقد يوجد صف عنوان (مثل اسم مشروع) يخص الصفوف التالية.

المطلوب:
- أخرج بنداً منفصلاً لكل حساب: بند مدين (debit) أو بند دائن (credit)، ولا تضع المبلغين في بند واحد. رتّب البنود كما تظهر في المستند، ويأتي بند الصف المدين قبل بنده الدائن.
- account_text: اسم الحساب كما هو مكتوب في المستند.
- account_code: رمز الحساب المطابق من شجرة الحسابات أدناه، فقط إذا كانت المطابقة واضحة؛ وإلا null. عند تكرار الاسم في أكثر من فرع اختر الأنسب للسياق (مثل اسم المشروع) أو اتركه null واذكر السبب.
- label: البيان الذي يخص هذا البند (انسخه للبنود التي يشملها). أضف اسم المشروع إن وُجد صف عنوان لمشروع.
- number: رقم القيد كما هو (مثل "5/8")، و date بصيغة YYYY-MM-DD، أو null إن تعذرت قراءتهما.
- إذا كُتب 0 صراحةً في خانة فهو 0، والخانة الفارغة null.
- uncertain = true لأي بند لم تتأكد من رقمه أو حسابه أو بيانه، مع ذكر السبب في uncertain_reason (وإلا نص فارغ).
- notes: ملخص قصير بالعربية لما لم تستطع قراءته أو يحتاج مراجعة، وهل يتطابق مجموع المدين والدائن مع سطر "المجموع" المكتوب. لا تخترع أرقاماً غير موجودة.

شجرة الحسابات (الرمز | الاسم | الحساب الأب):
"""


class MyAccountingPhotoEntry(models.Model):
    _name = 'myaccounting.photo.entry'
    _description = 'قيد من صورة (بانتظار التأكيد)'
    _order = 'id desc'

    image = fields.Binary(string='صورة المستند', attachment=True, copy=False)
    image_mimetype = fields.Char(default='image/jpeg')

    name = fields.Char(string='رقم القيد')
    date = fields.Date(string='التاريخ')
    ledger_month = fields.Selection(LEDGER_MONTH_SELECTION, string='شهر دفتر الأستاذ')
    ledger_year = fields.Integer(string='سنة دفتر الأستاذ')
    journal = fields.Char(string='اليومية', default='القيود اليدوية')
    notes = fields.Text(string='ملاحظات القراءة', readonly=True)
    provider = fields.Selection(PROVIDERS, string='قُرئ بواسطة', readonly=True)
    state = fields.Selection([('new', 'بانتظار القراءة'), ('review', 'بانتظار التأكيد'), ('posted', 'مُرحّل')],
                             string='الحالة', default='new', readonly=True)
    read_count = fields.Integer(string='عدد مرات القراءة', readonly=True)
    # حالة القراءة في الخلفية (لشريط التقدم)
    read_state = fields.Selection([
        ('idle', '—'), ('queued', 'في الانتظار'), ('running', 'جارِ القراءة'),
        ('done', 'اكتملت القراءة'), ('failed', 'فشلت القراءة'),
    ], string='حالة القراءة', default='idle', readonly=True)
    read_step = fields.Integer(string='خطوة القراءة', readonly=True)
    read_provider = fields.Selection(PROVIDERS, string='القراءة المطلوبة بـ', readonly=True)
    read_error = fields.Text(string='سبب فشل القراءة', readonly=True)
    read_started = fields.Datetime(string='بدء القراءة', readonly=True)
    read_finished = fields.Datetime(string='انتهاء القراءة', readonly=True)
    # القراءة الجماعية: إعادة المحاولة تلقائياً عند الفشل المؤقت حتى النجاح أو الإيقاف اليدوي
    read_auto_retry = fields.Boolean(string='إعادة المحاولة تلقائياً', readonly=True)
    read_attempts = fields.Integer(string='عدد المحاولات', readonly=True)
    read_next_try = fields.Datetime(string='المحاولة التالية', readonly=True)
    read_batch = fields.Char(string='دفعة القراءة', readonly=True, index=True)
    move_id = fields.Many2one('myaccounting.move', string='القيد المُنشأ', readonly=True, ondelete='set null')
    line_ids = fields.One2many('myaccounting.photo.entry.line', 'entry_id', string='البنود')
    total_debit = fields.Float(string='إجمالي المدين', compute='_compute_totals', digits=(16, 3))
    total_credit = fields.Float(string='إجمالي الدائن', compute='_compute_totals', digits=(16, 3))
    is_balanced = fields.Boolean(string='متوازن', compute='_compute_totals')
    uncertain_count = fields.Integer(string='بنود تحتاج مراجعة', compute='_compute_totals')
    existing_move_id = fields.Many2one('myaccounting.move', string='قيد بنفس الرقم',
                                       compute='_compute_existing_move')

    @api.depends('name', 'state')
    def _compute_display_name(self):
        for entry in self:
            entry.display_name = entry.name or f'صورة #{entry.id or ""}'

    @api.depends('name')
    def _compute_existing_move(self):
        # تنبيه قبل الترحيل: هل أُدخل هذا المستند يدوياً من قبل؟
        Move = self.env['myaccounting.move']
        for entry in self:
            if entry.name and entry.state == 'review':
                entry.existing_move_id = Move.search([('name', '=', entry.name)], limit=1)
            else:
                entry.existing_move_id = False

    @api.depends('line_ids.debit', 'line_ids.credit', 'line_ids.uncertain')
    def _compute_totals(self):
        for entry in self:
            entry.total_debit = sum(entry.line_ids.mapped('debit'))
            entry.total_credit = sum(entry.line_ids.mapped('credit'))
            entry.is_balanced = round(entry.total_debit - entry.total_credit, 3) == 0.0
            entry.uncertain_count = len(entry.line_ids.filtered('uncertain'))

    # ------------------------------------------------------------------
    # خدمة القراءة ومفاتيحها (يُدخلها المدير بنفسه من صفحة التصوير)
    # ------------------------------------------------------------------

    @api.model
    def get_photo_page_info(self):
        params = self.env['ir.config_parameter'].sudo()
        waiting = self.search([('state', 'in', ('new', 'review'))])
        return {
            'has_claude_key': bool(params.get_param(API_KEY_PARAM)),
            'has_gemini_key': bool(params.get_param(GEMINI_KEY_PARAM)),
            'gemini_model': params.get_param(GEMINI_MODEL_PARAM) or GEMINI_DEFAULT_MODEL,
            'is_admin': self.env.user.has_group('base.group_system'),
            'new_count': len(waiting.filtered(lambda e: e.state == 'new')),
            'review_count': len(waiting.filtered(lambda e: e.state == 'review')),
            'recent': [{'id': e.id, 'label': e.display_name, 'state': e.state, 'read_state': e.read_state,
                        'created': fields.Datetime.to_string(e.create_date)} for e in waiting[:15]],
        }

    @api.model
    def _check_admin(self):
        if not self.env.user.has_group('base.group_system'):
            raise AccessError('فقط مدير النظام يمكنه تغيير إعدادات القراءة.')

    @api.model
    def set_api_key(self, api_key, provider='claude'):
        self._check_admin()
        param = GEMINI_KEY_PARAM if provider == 'gemini' else API_KEY_PARAM
        self.env['ir.config_parameter'].sudo().set_param(param, (api_key or '').strip() or False)
        return True

    @api.model
    def set_gemini_model(self, model):
        self._check_admin()
        model = (model or '').strip()
        if model and not re.fullmatch(r'[a-z0-9.\-]+', model):
            raise UserError('اسم نموذج Gemini غير صالح.')
        self.env['ir.config_parameter'].sudo().set_param(GEMINI_MODEL_PARAM, model or False)
        return True

    # ------------------------------------------------------------------
    # القراءة
    # ------------------------------------------------------------------

    @api.model
    def _accounts_prompt(self):
        lines = []
        for account in self.env['myaccounting.account'].search([], order='code'):
            lines.append(f'{account.code} | {account.name} | {account.parent_id.name or "-"}')
        return '\n'.join(lines)

    @api.model
    def _read_voucher(self, image_b64, media_type, provider):
        if provider == 'gemini':
            return self._read_with_gemini(image_b64, media_type)
        return self._read_with_claude(image_b64, media_type)

    @api.model
    def _parse_json(self, text, provider_name):
        try:
            data = json.loads(text)
        except (json.JSONDecodeError, TypeError) as error:
            raise TransientReadError(f'لم يُرجع {provider_name} بيانات صالحة. حاول مرة أخرى.') from error
        if not isinstance(data, dict) or not isinstance(data.get('lines'), list):
            raise TransientReadError(f'لم يُرجع {provider_name} بيانات صالحة. حاول مرة أخرى.')
        return data

    @api.model
    def _read_with_gemini(self, image_b64, media_type):
        params = self.env['ir.config_parameter'].sudo()
        api_key = params.get_param(GEMINI_KEY_PARAM)
        if not api_key:
            raise UserError('لم يُضبط مفتاح Gemini API بعد.')
        model = params.get_param(GEMINI_MODEL_PARAM) or GEMINI_DEFAULT_MODEL
        body = {
            'systemInstruction': {'parts': [{'text': SYSTEM_PROMPT + self._accounts_prompt()}]},
            'contents': [{'role': 'user', 'parts': [
                {'inline_data': {'mime_type': media_type, 'data': image_b64}},
                {'text': 'اقرأ مستند القيد في الصورة وأخرج بياناته بصيغة JSON.'},
            ]}],
            'generationConfig': {
                'responseMimeType': 'application/json',
                'responseJsonSchema': gemini_schema(VOUCHER_SCHEMA),
            },
        }
        try:
            # المفتاح في الترويسة وليس في الرابط
            response = requests.post(GEMINI_URL.format(model=model), json=body, timeout=300,
                                     headers={'x-goog-api-key': api_key})
        except requests.RequestException as error:
            raise TransientReadError('تعذّر الاتصال بـ Gemini API. تحقّق من اتصال الخادم بالإنترنت.') from error
        if response.status_code != 200:
            try:
                message = response.json().get('error', {}).get('message', '')
            except ValueError:
                message = response.text[:300]
            if response.status_code in (401, 403) or 'API key' in message:
                raise UserError('مفتاح Gemini API غير صحيح أو لا يملك صلاحية. أدخل المفتاح الصحيح من صفحة التصوير.')
            if response.status_code == 404:
                raise UserError(f'نموذج Gemini "{model}" غير متاح. غيّر اسم النموذج من صفحة التصوير.')
            if response.status_code == 429:
                raise TransientReadError('تم تجاوز حد الاستخدام المجاني لـ Gemini. حاول لاحقاً (الحد يتجدد يومياً).')
            if response.status_code >= 500:
                raise TransientReadError('خدمة Gemini مضغوطة حالياً. الصورة محفوظة: حاول لاحقاً أو اقرأها بـ Claude.')
            raise UserError(f'خطأ من Gemini ({response.status_code}): {message}')

        result = response.json()
        block = (result.get('promptFeedback') or {}).get('blockReason')
        candidates = result.get('candidates') or []
        if block or not candidates:
            raise UserError('رفض Gemini قراءة هذه الصورة. جرّب صورة أوضح للمستند.')
        candidate = candidates[0]
        if candidate.get('finishReason') == 'MAX_TOKENS':
            raise TransientReadError('انقطعت القراءة قبل اكتمالها. حاول مرة أخرى.')
        # نتجاهل أجزاء "التفكير" ونأخذ النص الناتج فقط
        text = ''.join(part.get('text', '') for part in (candidate.get('content') or {}).get('parts', [])
                       if not part.get('thought'))
        data = self._parse_json(text, 'Gemini')
        _logger.info('Photo entry read by Gemini %s: %s lines, usage %s',
                     model, len(data['lines']), result.get('usageMetadata'))
        return data

    @api.model
    def _read_with_claude(self, image_b64, media_type):
        try:
            import anthropic
        except ImportError as error:
            raise UserError('مكتبة anthropic غير مثبتة على الخادم.') from error

        api_key = self.env['ir.config_parameter'].sudo().get_param(API_KEY_PARAM)
        client = anthropic.Anthropic(api_key=api_key, timeout=300) if api_key else anthropic.Anthropic(timeout=300)
        try:
            response = client.beta.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=16000,
                thinking={'type': 'adaptive'},
                output_config={'effort': 'high', 'format': {'type': 'json_schema', 'schema': VOUCHER_SCHEMA}},
                # شجرة الحسابات ثابتة بين الطلبات: تُخزَّن مؤقتاً لتقليل الكلفة
                system=[{'type': 'text', 'text': SYSTEM_PROMPT + self._accounts_prompt(),
                         'cache_control': {'type': 'ephemeral'}}],
                messages=[{'role': 'user', 'content': [
                    {'type': 'image', 'source': {'type': 'base64', 'media_type': media_type, 'data': image_b64}},
                    {'type': 'text', 'text': 'اقرأ مستند القيد في الصورة وأخرج بياناته.'},
                ]}],
                # إن رفض النموذج الطلب لسبب أمني يُعاد تلقائياً على النموذج البديل المناسب
                betas=['server-side-fallback-2026-07-01'],
                fallbacks='default',
            )
        except anthropic.AuthenticationError as error:
            raise UserError('مفتاح Claude API غير صحيح. أدخل المفتاح الصحيح من صفحة التصوير.') from error
        except anthropic.PermissionDeniedError as error:
            raise UserError('مفتاح Claude API لا يملك صلاحية استخدام هذا النموذج.') from error
        except anthropic.RateLimitError as error:
            raise TransientReadError('تم تجاوز حد الطلبات على Claude API. حاول بعد قليل.') from error
        except anthropic.BadRequestError as error:
            raise UserError(f'رفض Claude API الطلب: {error.message}') from error
        except anthropic.APIStatusError as error:
            if error.status_code >= 500:
                raise TransientReadError('خدمة Claude مضغوطة حالياً. الصورة محفوظة: حاول لاحقاً أو اقرأها بـ Gemini.') from error
            raise UserError(f'خطأ من خادم Claude ({error.status_code}). حاول مرة أخرى.') from error
        except anthropic.APIConnectionError as error:
            raise TransientReadError('تعذّر الاتصال بـ Claude API. تحقّق من اتصال الخادم بالإنترنت.') from error

        if response.stop_reason == 'refusal':
            raise UserError('رفض Claude قراءة هذه الصورة. جرّب صورة أوضح للمستند.')
        if response.stop_reason == 'max_tokens':
            raise TransientReadError('انقطعت القراءة قبل اكتمالها. حاول مرة أخرى.')
        text = next((block.text for block in response.content if block.type == 'text'), '')
        data = self._parse_json(text, 'Claude')
        _logger.info('Photo entry read: %s lines, usage %s', len(data.get('lines') or []), response.usage)
        return data

    @api.model
    def _parse_date(self, value):
        if not value:
            return False
        try:
            return fields.Date.to_date(normalize_digits(str(value)).strip())
        except (ValueError, TypeError):
            return False

    @api.model
    def _vals_from_voucher(self, data):
        """يحوّل ما قرأه Claude إلى قيم قيد صورة، مع ربط الحسابات برموزها."""
        Account = self.env['myaccounting.account']
        number = normalize_digits(data.get('number') or '').strip() or False
        date = self._parse_date(data.get('date'))
        # الرقم يُكتب من اليمين (6/8)، وقد يُقرأ معكوساً (8/6): إن كان جزؤه الأول هو شهر
        # التاريخ والثاني ليس كذلك، نعيده للترتيب الصحيح
        reversed_match = re.match(r'^\s*(\d+)\s*/\s*(\d+)\s*$', number or '')
        if reversed_match and date:
            first, second = int(reversed_match.group(1)), int(reversed_match.group(2))
            if first == date.month and second != date.month:
                number = f'{second}/{first}'
        # الشهر من رقم القيد (5/8 → 8)، وإلا من التاريخ
        month = False
        match = re.match(r'^\s*\d+\s*/\s*(\d{1,2})\s*$', number or '')
        if match and 1 <= int(match.group(1)) <= 12:
            month = str(int(match.group(1)))
        elif date:
            month = str(date.month)
        year = date.year if date else fields.Date.context_today(self).year

        lines = []
        for index, line in enumerate(data.get('lines') or []):
            code = normalize_digits(line.get('account_code') or '').strip()
            account = Account.search([('code', '=', code)], limit=1) if code else Account
            debit, credit = line.get('debit'), line.get('credit')
            reason = (line.get('uncertain_reason') or '').strip()
            if code and not account:
                reason = (reason + ' — ' if reason else '') + f'الرمز {code} غير موجود في شجرة الحسابات'
            lines.append((0, 0, {
                'sequence': (index + 1) * 10,
                'account_id': account.id or False,
                'account_text': (line.get('account_text') or '').strip(),
                'name': (line.get('label') or '').strip() or False,
                'debit': debit or 0.0,
                'credit': credit or 0.0,
                'debit_zero_entered': debit == 0,
                'credit_zero_entered': credit == 0,
                'uncertain': bool(line.get('uncertain')) or not account,
                'uncertain_reason': reason or (False if account else 'لم يُحدَّد الحساب — اختره يدوياً'),
            }))
        return {
            'name': number,
            'date': date,
            'ledger_month': month,
            'ledger_year': year,
            'notes': (data.get('notes') or '').strip() or False,
            'line_ids': lines,
        }

    @api.model
    def upload_image(self, image_b64, media_type='image/jpeg'):
        """من صفحة التصوير: تُحفظ الصورة فقط بانتظار القراءة من الحاسوب."""
        if media_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif'):
            raise UserError('صيغة الصورة غير مدعومة. استخدم JPG أو PNG.')
        image_b64 = (image_b64 or '').split(',')[-1]  # إزالة بادئة data: إن وُجدت
        if len(base64.b64decode(image_b64)) > MAX_IMAGE_BYTES:
            raise UserError('الصورة كبيرة جداً (الحد 5 ميغابايت).')
        entry = self.create({'image': image_b64, 'image_mimetype': media_type, 'state': 'new'})
        return {'id': entry.id, 'label': entry.display_name}

    # ------------------------------------------------------------------
    # القراءة في الخلفية: الزر يضع الصورة في طابور، والمهمة المجدولة تقرؤها
    # ------------------------------------------------------------------

    def _request_read(self, provider):
        self.ensure_one()
        if self.state == 'posted':
            raise UserError('تم ترحيل هذا القيد، ولا يمكن إعادة قراءته.')
        if not self.image:
            raise UserError('لا توجد صورة محفوظة لهذا القيد.')
        if self.read_state in ('queued', 'running'):
            raise UserError('هناك قراءة جارية لهذه الصورة. انتظر حتى تنتهي.')
        self.write({'read_state': 'queued', 'read_provider': provider, 'read_step': 0,
                    'read_error': False, 'read_started': False, 'read_finished': False,
                    'read_auto_retry': False, 'read_attempts': 0, 'read_next_try': False})
        # تشغيل المهمة فوراً بدل انتظار موعدها الدوري
        self._read_cron()._trigger()
        return True

    def _read_cron(self):
        return self.env.ref('my_accounting.ir_cron_photo_read').sudo()

    def action_batch_read_gemini(self):
        """من القائمة: قراءة الصور المحددة بـ Gemini، مع إعادة المحاولة تلقائياً حتى النجاح."""
        entries = self.filtered(lambda e: e.image and e.state != 'posted' and e.read_state not in ('queued', 'running'))
        if not entries:
            raise UserError('لا توجد صور قابلة للقراءة ضمن التحديد (مرحّلة، أو بلا صورة، أو قراءتها جارية).')
        batch = fields.Datetime.to_string(fields.Datetime.now())
        entries.write({'read_state': 'queued', 'read_provider': 'gemini', 'read_step': 0,
                       'read_error': False, 'read_started': False, 'read_finished': False,
                       'read_auto_retry': True, 'read_attempts': 0, 'read_next_try': False,
                       'read_batch': batch})
        self._read_cron()._trigger()
        return {
            'type': 'ir.actions.client',
            'tag': 'my_accounting.photo_batch',
            'name': 'القراءة الجماعية بـ Gemini',
            'context': {'photo_batch': batch},
        }

    def action_stop_read(self):
        """إيقاف إعادة المحاولة. قراءة جارية الآن تكتمل، لكن لا تُعاد إن فشلت."""
        for entry in self:
            vals = {'read_auto_retry': False, 'read_next_try': False}
            if entry.read_state == 'queued':
                last = f' (آخر خطأ: {entry.read_error})' if entry.read_error else ''
                vals.update({'read_state': 'failed', 'read_finished': fields.Datetime.now(),
                             'read_error': f'أوقفتَ القراءة يدوياً{last}.'})
            entry.write(vals)
        return True

    @api.model
    def get_batch_status(self, batch=False):
        """حالة دفعة القراءة الجماعية (آخر دفعة إن لم تُحدَّد) لصفحة التقدم."""
        if not batch:
            last = self.search([('read_batch', '!=', False)], order='read_batch desc', limit=1)
            batch = last.read_batch
        entries = self.search([('read_batch', '=', batch)], order='id') if batch else self
        now = fields.Datetime.now()
        items = []
        for entry in entries:
            items.append({
                'id': entry.id,
                'label': entry.display_name,
                'state': entry.state,
                'read_state': entry.read_state,
                'read_step': entry.read_step,
                'attempts': entry.read_attempts,
                'auto_retry': entry.read_auto_retry,
                'retry_in': max(0, int((entry.read_next_try - now).total_seconds())) if entry.read_next_try else 0,
                'error': entry.read_error or '',
                'lines': len(entry.line_ids),
                'uncertain': entry.uncertain_count,
                'balanced': entry.is_balanced,
            })
        done = len([i for i in items if i['read_state'] == 'done'])
        failed = len([i for i in items if i['read_state'] == 'failed'])
        return {'batch': batch or False, 'items': items, 'total': len(items), 'done': done, 'failed': failed,
                'active': len(items) - done - failed}

    def action_read_claude(self):
        return self._request_read('claude')

    def action_read_gemini(self):
        return self._request_read('gemini')

    @api.model
    def _cron_process_reads(self):
        """المهمة المجدولة: تقرأ الصور التي في الطابور واحدة تلو الأخرى."""
        stale = self.search([('read_state', '=', 'running'),
                             ('read_started', '<', fields.Datetime.now() - timedelta(minutes=STALE_READ_MINUTES))])
        if stale:
            message = 'انقطعت القراءة قبل اكتمالها (ربما أُعيد تشغيل الخادم).'
            # في القراءة الجماعية تُعاد المحاولة، وفي القراءة الفردية تُعلَّم فاشلة
            stale.filtered('read_auto_retry').write({'read_state': 'queued', 'read_step': 0,
                                                     'read_error': message, 'read_next_try': False})
            stale.filtered(lambda e: not e.read_auto_retry).write({
                'read_state': 'failed', 'read_finished': fields.Datetime.now(),
                'read_error': message + ' أعد المحاولة.'})
            self.env.cr.commit()
        while True:
            self.env.cr.execute("""
                SELECT id FROM myaccounting_photo_entry
                 WHERE read_state = 'queued'
                   AND (read_next_try IS NULL OR read_next_try <= (now() at time zone 'UTC'))
                 ORDER BY read_next_try NULLS FIRST, write_date, id
                 LIMIT 1 FOR UPDATE SKIP LOCKED
            """)
            row = self.env.cr.fetchone()
            if not row:
                break
            self.browse(row[0])._run_read()
        # صور تنتظر موعد إعادة المحاولة: نوقظ المهمة في أقرب موعد
        waiting = self.search([('read_state', '=', 'queued'), ('read_next_try', '!=', False)],
                              order='read_next_try', limit=1)
        if waiting:
            self._read_cron()._trigger(at=waiting.read_next_try)

    def _set_read_step(self, step):
        # كل خطوة تُحفظ فوراً ليراها شريط التقدم في المتصفح
        self.write({'read_step': step})
        self.env.cr.commit()

    def _run_read(self):
        self.ensure_one()
        provider = self.read_provider or 'claude'
        self.write({'read_state': 'running', 'read_step': 1, 'read_started': fields.Datetime.now(),
                    'read_attempts': self.read_attempts + 1, 'read_next_try': False})
        self.env.cr.commit()
        try:
            image_b64 = self.image.decode() if isinstance(self.image, bytes) else self.image
            _logger.info('Photo entry %s: reading with %s (%s KB image)', self.id, provider, len(image_b64) * 3 // 4096)
            self._set_read_step(2)
            data = self._read_voucher(image_b64, self.image_mimetype or 'image/jpeg', provider)
            self._set_read_step(3)
            vals = self._vals_from_voucher(data)
            self._set_read_step(4)
            self.line_ids.unlink()
            # قراءة جديدة: تبقى اليومية كما اختارها المستخدم
            vals.pop('journal', None)
            self.write(dict(vals, provider=provider, state='review', read_count=self.read_count + 1,
                            read_state='done', read_step=5, read_finished=fields.Datetime.now(),
                            read_error=False, read_auto_retry=False))
            self.env.cr.commit()
            _logger.info('Photo entry %s: saved %s lines from %s', self.id, len(self.line_ids), provider)
        except Exception as error:
            self.env.cr.rollback()
            self.env.invalidate_all()
            if isinstance(error, UserError):
                message = error.args[0]
                _logger.warning('Photo entry %s: reading with %s failed: %s', self.id, provider, message)
            else:
                message = f'خطأ غير متوقع أثناء القراءة: {error}'
                _logger.exception('Photo entry %s: reading with %s failed', self.id, provider)
            # القراءة الجماعية: إعادة المحاولة بعد مهلة تتضاعف، إن كان الفشل مؤقتاً ولم يُوقفها المستخدم
            if isinstance(error, TransientReadError) and self.read_auto_retry:
                delay = min(RETRY_FIRST_SECONDS * 2 ** (self.read_attempts - 1), RETRY_MAX_SECONDS)
                self.write({'read_state': 'queued', 'read_step': 0, 'read_error': message,
                            'read_next_try': fields.Datetime.now() + timedelta(seconds=delay)})
                _logger.info('Photo entry %s: retrying in %ss (attempt %s)', self.id, delay, self.read_attempts)
            else:
                self.write({'read_state': 'failed', 'read_error': message, 'read_finished': fields.Datetime.now(),
                            'read_auto_retry': False})
            self.env.cr.commit()

    # ------------------------------------------------------------------
    # لف الصورة (إن التقطها الهاتف بالاتجاه الخطأ) قبل القراءة
    # ------------------------------------------------------------------

    def _rotate(self, degrees):
        """degrees موجبة = عكس عقارب الساعة (يساراً). تُحفظ الصورة ملفوفة."""
        self.ensure_one()
        if self.state == 'posted' or not self.image:
            raise UserError('لا توجد صورة للّف.')
        image = Image.open(io.BytesIO(base64.b64decode(self.image)))
        # نطبّق اتجاه الكاميرا المخزَّن في الصورة أولاً حتى يكون اللف على ما يراه المستخدم
        image = ImageOps.exif_transpose(image).rotate(degrees, expand=True)
        buffer = io.BytesIO()
        image.convert('RGB').save(buffer, 'JPEG', quality=90)
        self.write({'image': base64.b64encode(buffer.getvalue()), 'image_mimetype': 'image/jpeg'})
        return True

    def action_rotate_left(self):
        return self._rotate(90)

    def action_rotate_right(self):
        return self._rotate(-90)

    # ------------------------------------------------------------------
    # الترحيل: يُنشئ قيداً محاسبياً عادياً مرحّلاً
    # ------------------------------------------------------------------

    def action_post(self):
        self.ensure_one()
        if self.state == 'posted':
            raise UserError('تم ترحيل هذا القيد مسبقاً.')
        if not self.line_ids:
            raise UserError('لا توجد بنود في القيد. اقرأ الصورة أولاً أو أضف البنود يدوياً.')
        missing = self.line_ids.filtered(lambda line: not line.account_id)
        if missing:
            raise UserError('اختر الحساب لكل البنود قبل الترحيل:\n' +
                            '\n'.join(f'• {line.account_text or line.name or "—"}' for line in missing))
        if not self.is_balanced:
            raise UserError(f'القيد غير متوازن: المدين {self.total_debit:,.3f} والدائن {self.total_credit:,.3f}.')
        if not self.date:
            raise UserError('أدخل تاريخ القيد.')

        Move = self.env['myaccounting.move']
        vals = {
            'move_type': 'entry',
            'date': self.date,
            'journal': self.journal or 'القيود اليدوية',
            'ledger_year': self.ledger_year or self.date.year,
            'ledger_month': self.ledger_month or str(self.date.month),
            'line_ids': [(0, 0, {
                'sequence': line.sequence,
                'account_id': line.account_id.id,
                'name': line.name or False,
                'debit': line.debit,
                'credit': line.credit,
                'debit_zero_entered': line.debit_zero_entered,
                'credit_zero_entered': line.credit_zero_entered,
            }) for line in self.line_ids],
        }
        # رقم القيد المكتوب على المستند، ما لم يكن مستخدماً (عندها الترقيم التلقائي)
        if self.name and not Move.search_count([('name', '=', self.name)]):
            vals['name'] = self.name
        move = Move.create(vals)
        move.action_post()
        move.message_post(body='أُنشئ هذا القيد من صورة مستند (BETA) بعد المراجعة والتأكيد.')
        # بعد الترحيل لم تعد الصورة لازمة: تُحذف من النظام (مرفقها يُحذف معها)
        self.write({'state': 'posted', 'move_id': move.id, 'image': False})
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'myaccounting.move',
            'res_id': move.id,
            'views': [[False, 'form']],
            'target': 'current',
        }

    def action_open_move(self):
        self.ensure_one()
        return {'type': 'ir.actions.act_window', 'res_model': 'myaccounting.move',
                'res_id': self.move_id.id, 'views': [[False, 'form']], 'target': 'current'}


class MyAccountingPhotoEntryLine(models.Model):
    _name = 'myaccounting.photo.entry.line'
    _description = 'بند قيد من صورة'
    _order = 'sequence, id'

    entry_id = fields.Many2one('myaccounting.photo.entry', required=True, ondelete='cascade')
    sequence = fields.Integer(default=10)
    account_id = fields.Many2one('myaccounting.account', string='الحساب')
    account_text = fields.Char(string='الحساب كما قُرئ')
    name = fields.Char(string='البيان')
    debit = fields.Float(string='المدين (من)', digits=(16, 3))
    credit = fields.Float(string='الدائن (الى)', digits=(16, 3))
    debit_zero_entered = fields.Boolean()
    credit_zero_entered = fields.Boolean()
    uncertain = fields.Boolean(string='يحتاج مراجعة')
    uncertain_reason = fields.Char(string='سبب المراجعة')

    @api.onchange('account_id')
    def _onchange_account_id(self):
        # اختيار الحساب يدوياً يحل ملاحظة "لم يُحدَّد الحساب"
        if self.account_id and self.uncertain_reason == 'لم يُحدَّد الحساب — اختره يدوياً':
            self.uncertain = False
            self.uncertain_reason = False
