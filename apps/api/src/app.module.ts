import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { LocationsModule } from './locations/locations.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { CustomerAuthModule } from './customer-auth/customer-auth.module';
import { CustomersModule } from './customers/customers.module';
import { InternalAuthModule } from './internal-auth/internal-auth.module';
import { InternalUsersModule } from './internal-users/internal-users.module';
import { AdminAuditModule } from './admin-audit/admin-audit.module';
import { AdminPlatformModule } from './admin-platform/admin-platform.module';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    LocationsModule,
    CatalogModule,
    OrdersModule,
    CustomerAuthModule,
    CustomersModule,
    InternalAuthModule,
    InternalUsersModule,
    AdminAuditModule,
    AdminPlatformModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
