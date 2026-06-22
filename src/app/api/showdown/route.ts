import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({
    success: true,
    message: 'Showdown settlement is handled by on-chain game polling in the standalone client.',
  });
}
