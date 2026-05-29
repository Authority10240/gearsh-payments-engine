import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AdminService } from './admin.service';
import { AuditAction } from './audit-action.decorator';
import {
  ListAdminTransactionsQuery,
  ListAuditQuery,
  ListLedgerEntriesQuery,
  ListReconciliationRunsQuery,
  TriggerReconciliationQuery,
} from './dto/admin.dto';

/**
 * Admin module controller (PAY-007). Hosts the composite payments-admin
 * surface: reconciliation views, transactions list, escrow balances + ledger
 * by date, the stuck-states surface, and the audit-log read.
 *
 * Does NOT duplicate routes already owned by the per-module admin
 * controllers (escrow holds release/refund/freeze in EscrowController,
 * refunds POST in RefundsController, payouts retry/cancel in
 * AdminPayoutsController). The audit middleware mounted in AppModule wraps
 * EVERY `/v1/admin/*` route — including those owned by other modules — so
 * this controller only needs to add the missing surface.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('v1/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ── Reconciliation ──────────────────────────────────────────────────────

  @Get('reconciliation/runs')
  @ApiOperation({
    operationId: 'adminListReconciliationRuns',
    summary: 'List nightly reconciliation runs (cursor-paginated, filterable).',
  })
  @ApiOkResponse({ description: 'Page of reconciliation_runs.' })
  @AuditAction('admin.reconciliation.runs.list')
  listReconciliationRuns(@Query() query: ListReconciliationRunsQuery) {
    return this.admin.listReconciliationRuns(query);
  }

  @Get('reconciliation/runs/:id')
  @ApiOperation({
    operationId: 'adminGetReconciliationRun',
    summary: 'Reconciliation run detail (includes findings JSONB).',
  })
  @AuditAction('admin.reconciliation.runs.get')
  getReconciliationRun(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string) {
    return this.admin.getReconciliationRun(id);
  }

  @Post('reconciliation/run')
  @HttpCode(202)
  @ApiOperation({
    operationId: 'adminTriggerReconciliation',
    summary: 'Trigger an immediate reconciliation run (defaults to yesterday SAST).',
  })
  @AuditAction('admin.reconciliation.trigger')
  triggerReconciliation(@Query() query: TriggerReconciliationQuery) {
    return this.admin.triggerReconciliation(query.asOfDate);
  }

  // ── Transactions ────────────────────────────────────────────────────────

  @Get('payments/transactions')
  @ApiOperation({
    operationId: 'adminListTransactions',
    summary: 'List payment transactions (cursor-paginated, filterable).',
  })
  @AuditAction('admin.payments.transactions.list')
  listTransactions(@Query() query: ListAdminTransactionsQuery) {
    return this.admin.listTransactions(query);
  }

  // ── Escrow balances + ledger ────────────────────────────────────────────

  @Get('escrow/balances')
  @ApiOperation({
    operationId: 'adminGetEscrowBalances',
    summary: 'Per-account ledger balances (DEBIT − CREDIT for ASSET, CREDIT − DEBIT otherwise).',
  })
  @AuditAction('admin.escrow.balances.get')
  getEscrowBalances() {
    return this.admin.getEscrowBalances();
  }

  @Get('escrow/ledger')
  @ApiOperation({
    operationId: 'adminListLedgerByDate',
    summary: 'List ledger_entries for a SAST day (defaults to today, cursor-paginated).',
  })
  @AuditAction('admin.escrow.ledger.list')
  listLedgerByDate(@Query() query: ListLedgerEntriesQuery) {
    return this.admin.listLedgerEntriesByDate(query);
  }

  // ── Stuck states ────────────────────────────────────────────────────────

  @Get('reconciliation/stuck/refunds')
  @ApiOperation({
    operationId: 'adminStuckRefunds',
    summary: 'Refunds in FAILED whose underlying hold is still HELD.',
  })
  @AuditAction('admin.reconciliation.stuck.refunds')
  stuckRefunds(@Query('limit') limit?: string) {
    return this.admin.stuckRefunds(parsePositiveInt(limit));
  }

  @Get('reconciliation/stuck/holds')
  @ApiOperation({
    operationId: 'adminStuckHolds',
    summary: 'Holds HELD past the configured age threshold.',
  })
  @AuditAction('admin.reconciliation.stuck.holds')
  stuckHolds(@Query('limit') limit?: string) {
    return this.admin.stuckHolds(parsePositiveInt(limit));
  }

  @Get('reconciliation/stuck/payouts')
  @ApiOperation({
    operationId: 'adminStuckPayouts',
    summary: 'Payouts QUEUED past the configured age threshold (dispatch missed).',
  })
  @AuditAction('admin.reconciliation.stuck.payouts')
  stuckPayouts(@Query('limit') limit?: string) {
    return this.admin.stuckPayouts(parsePositiveInt(limit));
  }

  @Get('reconciliation/stuck/disputes')
  @ApiOperation({
    operationId: 'adminStuckDisputes',
    summary: 'Holds DISPUTED past the configured age threshold (unresolved disputes).',
  })
  @AuditAction('admin.reconciliation.stuck.disputes')
  stuckDisputes(@Query('limit') limit?: string) {
    return this.admin.stuckDisputes(parsePositiveInt(limit));
  }

  // ── Audit log ───────────────────────────────────────────────────────────

  @Get('audit')
  @ApiOperation({
    operationId: 'adminListAudit',
    summary: 'List admin_audit_log entries (cursor-paginated, filterable).',
  })
  @AuditAction('admin.audit.list')
  listAudit(@Query() query: ListAuditQuery) {
    return this.admin.listAudit(query);
  }
}

/** Best-effort positive-int parse for the optional `?limit=` query param. */
function parsePositiveInt(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
