import { Module } from '@nestjs/common';
import { ReviewsService } from './reviews.service';

/**
 * Its own module because three unrelated places need it: the guest endpoint that accepts a
 * rating, and both channels' menu reads that display them. Hanging it off OrdersModule
 * would make CatalogModule import the whole order pipeline to render a star.
 */
@Module({
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
