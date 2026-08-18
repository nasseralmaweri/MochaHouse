import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The web app's cart page revalidates directly from the browser (it
  // reads localStorage, which only exists client-side), so this public,
  // unauthenticated read API must allow that cross-origin request.
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? 'http://localhost:3000',
  });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
