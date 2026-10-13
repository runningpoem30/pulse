import { NextRequest, NextResponse } from 'next/server';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { prisma } from '../../../lib/db';

const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const queueUrl = process.env.PROCESSOR_QUEUE_URL || 'local-mock-queue';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { dropAssignment, delayConfirm, duplicateConfirm } = body;
    
    const transactionId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const simulationId = crypto.randomUUID();

    // Create a simulation tracking record if needed, but for now we'll just track via Audit or metadata
    const startTime = new Date();

    const generateEvent = (action: string, offsetMs: number) => ({
      eventId: crypto.randomUUID(),
      transactionId,
      messageId: crypto.randomUUID(),
      orderId,
      action,
      eventType: action.toUpperCase(),
      timestamp: new Date(startTime.getTime() + offsetMs).toISOString(),
      participantId: 'buyer-app-1',
      participantRole: 'BUYER',
      domain: 'nic2004:60232',
      rawPayloadUri: `s3://mock-bucket/${transactionId}/${action}.json`,
    });

    const eventsToPush = [];
    
    // Standard flow up to init
    eventsToPush.push(generateEvent('search', 0));
    eventsToPush.push(generateEvent('on_search', 500));
    eventsToPush.push(generateEvent('select', 1000));
    eventsToPush.push(generateEvent('on_select', 1500));
    eventsToPush.push(generateEvent('init', 2000));
    eventsToPush.push(generateEvent('on_init', 2500));
    eventsToPush.push(generateEvent('confirm', 3000));

    // Fault injection
    if (duplicateConfirm) {
      eventsToPush.push(generateEvent('confirm', 3100)); // Send duplicate
    }
    
    if (delayConfirm) {
      // Simulate extreme delay (e.g. 5 minutes) before on_confirm
      eventsToPush.push(generateEvent('on_confirm', 300000));
    } else {
      eventsToPush.push(generateEvent('on_confirm', 3500));
    }

    if (!dropAssignment) {
      eventsToPush.push(generateEvent('on_status', 4000)); // Assignment completed
    }

    // Push to SQS
    for (const evt of eventsToPush) {
      if (queueUrl === 'local-mock-queue') {
        console.log('[LOCAL SQS MOCK] Pushing event:', evt.action);
        // In local mode without real SQS, we can't easily trigger the ProcessorLambda.
        // We log it, but the integration won't complete unless we run processor.ts locally.
      } else {
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(evt)
        }));
      }
    }

    // For polling purposes, we create a dummy incident if we are mocking locally? NO, SLA Engine creates it.
    // We will just return the transactionId so the frontend can poll OrderEvents table.
    
    return NextResponse.json({
      success: true,
      simulationId,
      transactionId,
      orderId,
      eventsScheduled: eventsToPush.length
    });

  } catch (error) {
    console.error('Simulation generation failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
