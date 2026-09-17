import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateVerificationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  cui!: string;
}
