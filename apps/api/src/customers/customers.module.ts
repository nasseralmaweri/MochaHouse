import { Module } from '@nestjs/common';
import { CustomersController } from './api/customers.controller';
import { CustomerPreferredLocationsController } from './api/customer-preferred-locations.controller';
import { CustomerPreferencesController } from './api/customer-preferences.controller';
import { CustomersService } from './application/customers.service';
import { CustomerPreferredLocationsService } from './application/customer-preferred-locations.service';
import { CustomerPreferencesService } from './application/customer-preferences.service';

// No CustomerAuthModule import here: CustomerAuthModule is @Global (see
// its own doc comment), so CustomerAuthGuard is already available for
// these controllers' @UseGuards() as long as CustomerAuthModule is
// loaded somewhere in the app (AppModule does). Importing it here would
// create a cycle now that CustomerAuthModule itself imports this module
// (AuthController's register/verify need CustomersService). PrismaService
// comes from the @Global PrismaModule.
@Module({
  controllers: [
    CustomersController,
    CustomerPreferredLocationsController,
    CustomerPreferencesController,
  ],
  providers: [
    CustomersService,
    CustomerPreferredLocationsService,
    CustomerPreferencesService,
  ],
  // Needed by CustomerAuthModule (registration/verification) and
  // OrdersModule (checkout's optional customer association, and the
  // customer order-history endpoints).
  exports: [CustomersService],
})
export class CustomersModule {}
