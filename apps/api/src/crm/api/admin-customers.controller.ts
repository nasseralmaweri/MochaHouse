import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CreateCustomerNoteRequest } from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { CrmCustomersService } from '../application/crm-customers.service';
import { CustomerNotesService } from '../application/customer-notes.service';

// Milestone 8A — Admin → Customers (the HQ CRM view over authoritative
// customer data). InternalAuthGuard (authentication + ACTIVE lifecycle)
// then PermissionGuard.
//   customers.view          — directory + aggregated detail + notes list.
//   customers.notes.manage  — add an internal CRM note.
// Both are CORPORATE-only in the permission catalog, so a LOCATION grant can
// never satisfy PermissionGuard; every service method also calls
// assertCorporate. Read-only apart from the append-only note POST — there
// is no customer edit / status-change route here.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/customers')
export class AdminCustomersController {
  constructor(
    private readonly crm: CrmCustomersService,
    private readonly notes: CustomerNotesService,
  ) {}

  @RequirePermission('customers.view')
  @Get()
  list(
    @Req() request: InternalAuthenticatedRequest,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.crm.list({ q, cursor }, request.authorization!);
  }

  @RequirePermission('customers.view')
  @Get(':customerId')
  detail(
    @Param('customerId') customerId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.crm.getDetail(customerId, request.authorization!);
  }

  @RequirePermission('customers.view')
  @Get(':customerId/notes')
  listNotes(
    @Param('customerId') customerId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.notes.listForCustomer(customerId, request.authorization!);
  }

  @RequirePermission('customers.notes.manage')
  @Post(':customerId/notes')
  addNote(
    @Param('customerId') customerId: string,
    @Body() body: CreateCustomerNoteRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.notes.addNote(
      customerId,
      body?.body,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
