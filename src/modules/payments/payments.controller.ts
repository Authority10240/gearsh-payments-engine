import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { InternalService } from '../../common/decorators/internal-service.decorator';
import { InternalServiceGuard } from '../../common/guards/internal-service.guard';
import type { AuthUser } from '../../common/auth-user';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { LockPaymentIntentResponse, PaymentIntentView } from './dto/payment-intent.view';
import { PaymentIntentsService } from './payment-intents.service';

@ApiTags('payments')
@Controller('v1/payment-intents')
export class PaymentsController {
  constructor(private readonly intents: PaymentIntentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @InternalService()
  @UseGuards(InternalServiceGuard)
  @ApiOperation({
    operationId: 'createPaymentIntent',
    summary: 'Create a payment intent for a booking (internal service auth).',
  })
  @ApiResponse({ status: 201, type: PaymentIntentView })
  async create(@Body() dto: CreatePaymentIntentDto): Promise<PaymentIntentView> {
    return this.intents.create(dto);
  }

  @Post(':id/lock')
  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'lockPaymentIntent',
    summary: 'Lock the FX rate and return signed PayFast form params.',
  })
  @ApiResponse({ status: 200, type: LockPaymentIntentResponse })
  @Header('Cache-Control', 'no-store')
  async lock(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<LockPaymentIntentResponse> {
    return this.intents.lock(id, user.sub, user.roles);
  }

  /**
   * Detail view. Reachable by:
   *   - the intent owner (JWT)
   *   - ADMIN role
   *   - an internal service token (PAY-002 webhook handler, etc.)
   *
   * Internal-service-only callers carry no `req.user`; the guard chain
   * recognises @InternalService() and skips the user-JWT check. The service
   * layer then enforces ownership.
   */
  @Get(':id')
  @ApiBearerAuth()
  @ApiOperation({ operationId: 'getPaymentIntent', summary: 'Get a payment intent by id.' })
  @ApiResponse({ status: 200, type: PaymentIntentView })
  async getById(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser | undefined,
  ): Promise<PaymentIntentView> {
    return this.intents.getById(id, user?.sub ?? null, user?.roles ?? [], false);
  }
}
