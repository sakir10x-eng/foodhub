import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, ZodSchema } from 'zod';

/**
 * Validates a request body/query against a zod schema from @foodhub/shared, so the
 * client and server enforce byte-identical rules.
 *
 * Usage: `@Body(new ZodBody(productSchema)) dto: ProductInput`
 */
@Injectable()
export class ZodBody<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({
          message: 'Validation failed',
          errors: err.issues.map((i) => ({
            field: i.path.join('.') || '_',
            message: i.message,
          })),
        });
      }
      throw err;
    }
  }
}
