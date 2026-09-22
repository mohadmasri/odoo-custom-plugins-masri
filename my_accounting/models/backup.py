import logging
import os
import subprocess
import sys
import textwrap
from datetime import datetime

import odoo.service.db

from odoo import api, fields, models
from odoo.exceptions import AccessDenied, AccessError, UserError
from odoo.tools import config as odoo_config

_logger = logging.getLogger(__name__)


class MyAccountingBackup(models.AbstractModel):
    _name = 'myaccounting.backup'
    _description = 'أداة النسخ الاحتياطي والاستعادة'

    @api.model
    def get_backup_data(self):
        accounts = self.env['myaccounting.account'].search([], order='id')
        moves = self.env['myaccounting.move'].search([], order='id')
        return {
            'version': 1,
            'exported_at': datetime.now().isoformat(),
            'accounts': [{
                'id': account.id,
                'name': account.name,
                'code': account.code,
                'parent_id': account.parent_id.id or None,
                'note': account.note or '',
                'active': account.active,
                'is_essential': account.is_essential,
                'ledger_sequence': account.ledger_sequence,
                'reviewed': account.reviewed,
                'reviewed_by': account.reviewed_by.id or None,
                'reviewed_date': account.reviewed_date.isoformat() if account.reviewed_date else None,
                'currency_code': account.currency_id.name or None,
                'company_name': account.company_id.name or None,
            } for account in accounts],
            'moves': [{
                'id': move.id,
                'name': move.name,
                'date': move.date.isoformat() if move.date else None,
                'ref': move.ref or '',
                'journal': move.journal or '',
                'state': move.state,
                'move_type': move.move_type,
                'ledger_month': move.ledger_month,
                'ledger_year': move.ledger_year,
                'import_notes': move.import_notes or '',
                'import_notes_reviewed': move.import_notes_reviewed,
                'currency_code': move.currency_id.name or None,
                'company_name': move.company_id.name or None,
                'allocations': [{
                    'customer_id': allocation.customer_id.id,
                    'invoice_number': allocation.invoice_number,
                    'amount': allocation.amount,
                } for allocation in self.env['myaccounting.receipt.allocation'].search(
                    [('receipt_move_id', '=', move.id)])],
                'lines': [{
                    'sequence': line.sequence,
                    'account_id': line.account_id.id,
                    'pending_account_name': line.pending_account_name or '',
                    'name': line.name or '',
                    'debit': line.debit,
                    'credit': line.credit,
                    'debit_zero_entered': line.debit_zero_entered,
                    'credit_zero_entered': line.credit_zero_entered,
                } for line in move.line_ids],
            } for move in moves],
            'review_notes': [{
                'key': note.key,
                'kind': note.kind or '',
                'title': note.title or '',
                'resolution': note.resolution,
                'resolved_by': note.resolved_by.login or None,
                'resolved_on': fields.Datetime.to_string(note.resolved_on) if note.resolved_on else None,
            } for note in self.env['myaccounting.review.note'].search([], order='id')],
        }

    def _resolve_currency_id(self, currency_code):
        if not currency_code:
            return False
        currency = self.env['res.currency'].search([('name', '=', currency_code)], limit=1)
        return currency.id if currency else False

    def _resolve_company_id(self, company_name):
        if not company_name:
            return False
        company = self.env['res.company'].search([('name', '=', company_name)], limit=1)
        return company.id if company else False

    @api.model
    def restore_backup_data(self, data):
        if not isinstance(data, dict) or 'accounts' not in data or 'moves' not in data:
            raise UserError('ملف النسخة الاحتياطية غير صالح أو تالف.')

        Account = self.env['myaccounting.account']
        Move = self.env['myaccounting.move']

        # حذف كل شيء أولاً. حذف القيود يحذف بنودها تلقائياً (cascade)،
        # وفك ارتباط الحسابات بآبائها قبل حذفها يتجنب قيد الحماية (restrict) على parent_id.
        Move.search([]).with_context(force_delete=True).unlink()
        existing_accounts = Account.search([])
        existing_accounts.write({'parent_id': False})
        existing_accounts.with_context(force_delete=True).unlink()

        # الخطوة الأولى: إنشاء الحسابات كلها دون ربط بالأب، مع حفظ خريطة الأرقام القديمة->الجديدة
        account_id_map = {}
        for acc in data['accounts']:
            account_vals = {
                'name': acc.get('name') or '/',
                'code': acc.get('code') or '/',
                'note': acc.get('note') or False,
                'active': acc.get('active', True),
                'is_essential': acc.get('is_essential', False),
                'ledger_sequence': acc.get('ledger_sequence', 100),
                'reviewed': acc.get('reviewed', False),
                'reviewed_by': acc.get('reviewed_by') or False,
                'reviewed_date': acc.get('reviewed_date') or False,
            }
            currency_id = self._resolve_currency_id(acc.get('currency_code'))
            if currency_id:
                account_vals['currency_id'] = currency_id
            company_id = self._resolve_company_id(acc.get('company_name'))
            if company_id:
                account_vals['company_id'] = company_id
            new_account = Account.create(account_vals)
            account_id_map[acc['id']] = new_account.id

        # الخطوة الثانية: إعادة ربط التسلسل الهرمي بين الحسابات
        for acc in data['accounts']:
            if acc.get('parent_id') and acc['parent_id'] in account_id_map:
                Account.browse(account_id_map[acc['id']]).write({
                    'parent_id': account_id_map[acc['parent_id']],
                })

        # إعادة إنشاء القيود وبنودها
        for mv in data['moves']:
            line_cmds = []
            for line in mv.get('lines', []):
                new_account_id = account_id_map.get(line.get('account_id'))
                # بنود "غير مكتملة" (مستوردة بلا حساب) تُستعاد باسم الحساب المعلّق
                if not new_account_id and not line.get('pending_account_name'):
                    continue
                line_cmds.append((0, 0, {
                    'sequence': line.get('sequence', 10),
                    'account_id': new_account_id or False,
                    'pending_account_name': line.get('pending_account_name') or False,
                    'name': line.get('name') or False,
                    'debit': line.get('debit') or 0.0,
                    'credit': line.get('credit') or 0.0,
                    'debit_zero_entered': bool(line.get('debit_zero_entered')),
                    'credit_zero_entered': bool(line.get('credit_zero_entered')),
                }))
            move_vals = {
                'name': mv.get('name') or '/',
                'date': mv.get('date') or False,
                'ref': mv.get('ref') or False,
                'journal': mv.get('journal') or False,
                'state': mv.get('state') or 'draft',
                'line_ids': line_cmds,
            }
            # ندعم أيضاً استعادة نسخ احتياطية قديمة لا تحتوي على هذه الحقول،
            # فنترك القيم الافتراضية تُطبَّق تلقائياً عندئذ.
            if mv.get('import_notes'):
                move_vals['import_notes'] = mv['import_notes']
                move_vals['import_notes_reviewed'] = mv.get('import_notes_reviewed', False)
            if mv.get('move_type'):
                move_vals['move_type'] = mv['move_type']
            if mv.get('ledger_month'):
                move_vals['ledger_month'] = mv['ledger_month']
            if mv.get('ledger_year'):
                move_vals['ledger_year'] = mv['ledger_year']
            currency_id = self._resolve_currency_id(mv.get('currency_code'))
            if currency_id:
                move_vals['currency_id'] = currency_id
            company_id = self._resolve_company_id(mv.get('company_name'))
            if company_id:
                move_vals['company_id'] = company_id
            new_move = Move.create(move_vals)
            # تخصيص سند القبض لفواتير (غير موجود في النسخ القديمة)
            for allocation in mv.get('allocations') or []:
                customer_id = account_id_map.get(allocation.get('customer_id'))
                if customer_id and allocation.get('invoice_number') and allocation.get('amount'):
                    self.env['myaccounting.receipt.allocation'].create({
                        'receipt_move_id': new_move.id,
                        'customer_id': customer_id,
                        'invoice_number': allocation['invoice_number'],
                        'amount': allocation['amount'],
                    })

        # حلول ملاحظات المراجعة (النسخ القديمة لا تحتويها؛ عندها تبقى الحلول الحالية كما هي)
        if 'review_notes' in data:
            Note = self.env['myaccounting.review.note']
            Note.search([]).unlink()
            for note in data['review_notes']:
                if not note.get('key') or not note.get('resolution'):
                    continue
                user = self.env['res.users'].search([('login', '=', note.get('resolved_by'))], limit=1) \
                    if note.get('resolved_by') else False
                Note.create({
                    'key': note['key'],
                    'kind': note.get('kind') or False,
                    'title': note.get('title') or False,
                    'resolution': note['resolution'],
                    'resolved_by': (user or self.env.user).id,
                    'resolved_on': note.get('resolved_on') or fields.Datetime.now(),
                })

        return {
            'accounts_count': len(data['accounts']),
            'moves_count': len(data['moves']),
        }

    # ========================================================================
    # النسخ الاحتياطي التلقائي (نسخة كاملة: قاعدة البيانات + الملفات)
    # ========================================================================

    AUTO_BACKUP_PARAMS = {
        'enabled': 'my_accounting.auto_backup_enabled',
        'directory': 'my_accounting.auto_backup_directory',
        'keep': 'my_accounting.auto_backup_keep',
        'last_status': 'my_accounting.auto_backup_last_status',
    }

    @api.model
    def _auto_backup_default_directory(self):
        return os.path.join(odoo_config['data_dir'], 'my_accounting_backups')

    @api.model
    def get_auto_backup_config(self):
        params = self.env['ir.config_parameter'].sudo()
        keys = self.AUTO_BACKUP_PARAMS
        directory = params.get_param(keys['directory']) or self._auto_backup_default_directory()
        return {
            'enabled': params.get_param(keys['enabled']) == '1',
            'directory': directory,
            'keep': int(params.get_param(keys['keep']) or 14),
            'last_status': params.get_param(keys['last_status']) or '',
            'files': self.list_backup_files(directory),
        }

    @api.model
    def set_auto_backup_config(self, enabled, directory, keep):
        params = self.env['ir.config_parameter'].sudo()
        keys = self.AUTO_BACKUP_PARAMS
        directory = (directory or '').strip() or self._auto_backup_default_directory()
        try:
            keep = max(1, min(int(keep), 365))
        except (TypeError, ValueError):
            keep = 14
        params.set_param(keys['enabled'], '1' if enabled else '0')
        params.set_param(keys['directory'], directory)
        params.set_param(keys['keep'], str(keep))
        return self.get_auto_backup_config()

    @api.model
    def list_backup_files(self, directory=None):
        params = self.env['ir.config_parameter'].sudo()
        directory = directory or params.get_param(
            self.AUTO_BACKUP_PARAMS['directory']) or self._auto_backup_default_directory()
        if not os.path.isdir(directory):
            return []
        files = []
        for name in os.listdir(directory):
            path = os.path.join(directory, name)
            if name.endswith('.zip') and os.path.isfile(path):
                stat = os.stat(path)
                files.append({
                    'name': name,
                    'size_mb': round(stat.st_size / (1024 * 1024), 1),
                    'date': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M'),
                    'timestamp': stat.st_mtime,
                })
        return sorted(files, key=lambda item: -item['timestamp'])

    @api.model
    def run_auto_backup(self, manual=False):
        """ينشئ نسخة كاملة (قاعدة البيانات + المرفقات) في المجلد المحدَّد،
        ثم يحذف النسخ الأقدم مع الإبقاء على العدد المطلوب."""
        params = self.env['ir.config_parameter'].sudo()
        keys = self.AUTO_BACKUP_PARAMS
        if not manual and params.get_param(keys['enabled']) != '1':
            return {'skipped': True}

        directory = params.get_param(keys['directory']) or self._auto_backup_default_directory()
        keep = int(params.get_param(keys['keep']) or 14)
        db_name = self.env.cr.dbname
        started = datetime.now()
        try:
            os.makedirs(directory, exist_ok=True)
            filename = f"{db_name}_{started.strftime('%Y-%m-%d_%H%M')}.zip"
            path = os.path.join(directory, filename)
            # نكتب إلى ملف مؤقت ثم نعيد تسميته، حتى لا تبقى نسخة ناقصة إن انقطعت العملية
            temp_path = path + '.part'
            with open(temp_path, 'wb') as stream:
                odoo.service.db.dump_db(db_name, stream, 'zip')
            os.replace(temp_path, path)
            size_mb = round(os.path.getsize(path) / (1024 * 1024), 1)

            removed = 0
            for old in self.list_backup_files(directory)[keep:]:
                try:
                    os.remove(os.path.join(directory, old['name']))
                    removed += 1
                except OSError:
                    pass

            status = (f"آخر نسخة: {started.strftime('%Y-%m-%d %H:%M')} — {filename} "
                      f"({size_mb} ميغابايت)" + (f"، حُذفت {removed} نسخة قديمة" if removed else ''))
            params.set_param(keys['last_status'], status)
            _logger.info('my_accounting: auto backup written to %s (%s MB)', path, size_mb)
            return {'success': True, 'filename': filename, 'size_mb': size_mb,
                    'removed': removed, 'status': status, 'directory': directory}
        except Exception as error:  # noqa: BLE001 - نسجّل السبب ولا نُسقط المهمة المجدولة
            status = f"فشلت النسخة في {started.strftime('%Y-%m-%d %H:%M')}: {error}"
            params.set_param(keys['last_status'], status)
            _logger.exception('my_accounting: auto backup failed')
            return {'success': False, 'error': str(error), 'status': status}

    # ========================================================================
    # إعادة تشغيل الخادم من داخل النظام
    # ========================================================================

    @api.model
    def restart_server(self, password):
        """يعيد تشغيل خادم أودو بعد التحقق من كلمة مرور المستخدم الحالي.

        متاحة لمدير النظام فقط، ويُطلب إدخال كلمة المرور في كل مرة."""
        if not self.env.user.has_group('base.group_system'):
            raise AccessError('إعادة تشغيل النظام متاحة لمدير النظام فقط.')
        if not password:
            raise UserError('أدخل كلمة المرور لتأكيد إعادة التشغيل.')

        user = self.env.user
        credential = {'login': user.login, 'password': password, 'type': 'password'}
        try:
            user._check_credentials(credential, {'interactive': True})
        except AccessDenied:
            raise UserError('كلمة المرور غير صحيحة.') from None

        _logger.warning('my_accounting: server restart requested by %s (uid=%s)', user.login, user.id)
        return self._restart_now()

    def _restart_now(self):
        """يعيد تشغيل الخادم فعلياً. لا يتحقق من شيء، فلا تُستدعى مباشرة
        من الواجهة؛ استخدم restart_server التي تتحقق من الصلاحية وكلمة المرور.

        لا نستخدم odoo.service.server.restart() لأنها على ويندوز توقف الخادم
        دون أن تعيده. بدلاً منها نشغّل عملية مستقلة تنتظر ثانيتين (ليصل الرد
        إلى المتصفح)، ثم توقف كل عمليات أودو وتشغّل خادماً جديداً بنفس
        سطر الأوامر. ننتظر قليلاً قبل الإيقاف حتى تُحفظ المعاملة الحالية."""
        workdir = os.getcwd()
        log_path = os.path.join(workdir, 'server.log')
        command = [sys.executable] + list(sys.argv)
        # الخادم الجديد يكتب سجله دائماً في server.log لتشخيص أي مشكلة لاحقاً
        if not any(arg.startswith('--logfile') for arg in command):
            command.append(f'--logfile={log_path}')
        helper_path = os.path.join(odoo_config['data_dir'], 'my_accounting_restart.py')

        # نوقف كل عمليات أودو (الجذر وأبناءه)؛ ملف المساعد نفسه لا يحوي
        # "odoo-bin" في سطر أوامره فلا يوقف نفسه.
        helper_code = textwrap.dedent(f"""
            import os, subprocess, time

            time.sleep(3)
            if os.name == 'nt':
                subprocess.run([
                    'powershell', '-NoProfile', '-Command',
                    "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
                    "Where-Object {{ $_.CommandLine -like '*odoo-bin*' }} | "
                    "ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}",
                ], capture_output=True)
            else:
                subprocess.run(['pkill', '-f', 'odoo-bin'], capture_output=True)
            time.sleep(4)
            kwargs = {{'cwd': {workdir!r}, 'close_fds': True}}
            if os.name == 'nt':
                kwargs['creationflags'] = 0x00000008 | 0x00000200
            else:
                kwargs['start_new_session'] = True
            with open({log_path!r}, 'ab') as log:
                subprocess.Popen({command!r}, stdout=log, stderr=log, **kwargs)
        """)
        with open(helper_path, 'w', encoding='utf-8') as helper_file:
            helper_file.write(helper_code)

        popen_kwargs = {'cwd': workdir, 'close_fds': True}
        if os.name == 'nt':
            popen_kwargs['creationflags'] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | NEW_GROUP
        else:
            popen_kwargs['start_new_session'] = True
        subprocess.Popen([sys.executable, helper_path], **popen_kwargs)
        _logger.warning('my_accounting: restart helper launched (%s)', helper_path)
        return {'success': True}
