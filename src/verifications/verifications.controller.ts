import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CreateVerificationDto } from './dto/create-verification.dto';
import { VerificationsService } from './verifications.service';

@Controller('verifications')
export class VerificationsController {
  constructor(private readonly verifications: VerificationsService) {}

  /**
   * Always 201 when the check ran, whatever the outcome.
   *
   * "Company not found" and "ANAF unavailable" are 201 with a status field, not 404 or
   * 502. The resource being created is the VERIFICATION, and it exists in every one of
   * those cases — it is the record that the check was performed, which is the thing the
   * agency has to be able to show. 404 would claim the verification does not exist,
   * which is false and would lose the audit trail.
   *
   * A malformed CUI is a 400: nothing was checked and no record is worth keeping.
   */
  @Post()
  async create(@Body() dto: CreateVerificationDto) {
    const { verification, company, message } = await this.verifications.create(dto.cui);
    return {
      id: verification.id,
      status: verification.status,
      requestedCui: verification.requestedCui,
      startedAt: verification.startedAt,
      finishedAt: verification.finishedAt,
      message,
      company,
    };
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    const result = await this.verifications.findOne(id);
    if (!result) throw new NotFoundException(`Verification ${id} not found`);
    return result;
  }
}
