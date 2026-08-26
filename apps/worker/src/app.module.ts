import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { OutboxModule } from './outbox/outbox.module';

@Module({
  imports: [PrismaModule, OutboxModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
