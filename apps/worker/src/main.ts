import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // R1 / S4b — on SIGTERM/SIGINT the notification worker stops claiming, lets
  // attempts in flight finish and releases claims it has not started (see
  // OutboxProcessorService.stop). Without this the process would be killed
  // mid-attempt and rely on lease expiry alone.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
