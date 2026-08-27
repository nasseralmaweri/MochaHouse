import { Module } from '@nestjs/common';
import { CustomersController } from './api/customers.controller';
import { CustomersService } from './application/customers.service';

// No CustomerAuthModule import here: CustomerAuthModule is @Global (see
// its own doc comment), so CustomerAuthGuard is already available for
// CustomersController's @UseGuards() as long as CustomerAuthModule is
// loaded somewhere in the app (AppModule does). Importing it here too
// would create a cycle now that CustomerAuthModule itself imports this
// module (AuthController's register/verify need CustomersService).
@Module({
  controllers: [CustomersController],
  providers: [CustomersService],
  // Needed by CustomerAuthModule (registration/verification) and
  // OrdersModule (checkout's optional customer association, and the
  // customer order-history endpoints).
  exports: [CustomersService],
})
export class CustomersModule {}
