import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OutboxProcessorService } from './outbox-processor.service';

@Module({
  imports: [PrismaModule],
  providers: [OutboxProcessorService],
})
export class OutboxModule {}
