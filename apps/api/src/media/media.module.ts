import { Controller, Module, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MediaService } from './media.service';
import { CurrentUser, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';

@Controller('media')
class MediaController {
  constructor(private readonly media: MediaService) {}

  @Roles('VENDOR_OWNER', 'VENDOR_STAFF', 'PLATFORM_ADMIN')
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: any, @CurrentUser() user: AuthedUser) {
    return this.media.upload(file, user.tenantId);
  }
}

@Module({
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
