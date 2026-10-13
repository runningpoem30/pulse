import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { webhookPayloadSchema } from '../../../../apps/api/src/modules/events/schema';

const s3 = new S3Client({});
const sqs = new SQSClient({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  try {
    if (!event.body) { 
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing request body' }),
      };
    }

    const rawBody = JSON.parse(event.body);

    // 1. Validate Payload
    const parseResult = webhookPayloadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid payload', details: parseResult.error }),
      };
    }

    const { context, message } = parseResult.data;
    
    // 2. Store exact payload in S3
    const bucketName = process.env.RAW_EVENTS_BUCKET;
    if (!bucketName) throw new Error('RAW_EVENTS_BUCKET environment variable is missing');

    const date = new Date();
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    
    const s3Key = `raw/${year}/${month}/${day}/${context.transaction_id}/${context.message_id}.json`;

    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: event.body,
        ContentType: 'application/json',
      }));
    } catch (error) {
      console.error('Failed to store payload in S3:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal Server Error' }),
      };
    }

    // 3. Construct Canonical Event
    const fulfillmentState = message?.order?.fulfillments?.[0]?.state?.descriptor?.code;
    const canonicalEvent = {
      eventId: context.message_id,
      transactionId: context.transaction_id,
      messageId: context.message_id,
      orderId: message?.order?.id,
      action: context.action,
      eventType: context.action,
      timestamp: context.timestamp,
      participantId: context.action.startsWith('on_') ? context.bpp_id : context.bap_id,
      participantRole: context.action.startsWith('on_') ? 'SELLER' : 'BUYER',
      domain: context.domain,
      fulfillmentState: fulfillmentState,
      rawPayloadUri: `s3://${bucketName}/${s3Key}`
    };

    // 4. Send to SQS
    const queueUrl = process.env.PROCESSING_QUEUE_URL;
    if (!queueUrl) throw new Error('PROCESSING_QUEUE_URL environment variable is missing');

    try {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(canonicalEvent),
      }));
      
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, messageId: context.message_id }),
      };
    } catch (error) {
      console.error('Failed to send message to SQS:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal Server Error' }),
      };
    }

  } catch (error) {
    console.error('Unhandled error in ingest Lambda:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};
