# Executive Summary  

**ONDC Pulse** is an observability and reliability platform for ONDC-based commerce, built on AWS. Unlike ONDC’s existing dashboards (which show network-wide and participant-level KPIs), ONDC Pulse focuses on **per-order tracing and anomaly detection**. It ingests every ONDC protocol message from a seller participant’s system, normalizes them into a canonical event stream, and reconstructs each order’s state machine.  The system continuously monitors state transitions and timing (SLA) for each order, detects failures (missing or delayed callbacks), and groups them into incidents.  It provides an operations dashboard where merchant operators (or Seller Network Participants) can see real-time order health, event timelines, alerts for SLA breaches, and AI-generated explanations of problems.  Key features include: **Ingestion & Normalization**, **Order State Machine & SLA Engine**, **Incident Engine**, **Metrics & Tracing**, **Replay/Fault Injection**, and **LLM-assisted Explanation**.  

Implementation is AWS-centric: ONDC callbacks arrive via API Gateway to a Lambda, which validates and stores raw events (in S3) and normalized events (in Aurora). An event router (EventBridge/SQS) feeds an **Order Processor** that updates order state and computes SLAs. Detected anomalies create incidents (tracked in Aurora and notified via SNS). A Next.js dashboard (protected by Cognito) lets users view order timelines and incidents; it can also trigger simulations. Amazon Bedrock (LLM) is used only to *explain* incidents (not to detect them). A fault-injection mode lets the demo inject missing/delayed events to trigger failure scenarios on demand.  Time-series metrics (p50/p95/P99 latencies, error rates, SLA breach rates, per-participant breakdowns) can be computed either in Aurora or in Amazon Timestream.  

This report details the design: it identifies end users (e.g. seller operations teams of restaurant chains or marketplaces), contrasts ONDC Pulse with ONDC’s network dashboards, breaks down prioritized features with inputs/outputs and schemas, sketches the AWS architecture (with a mermaid diagram), outlines CI/CD (AWS CDK, pipelines), explains integration with ONDC pre-production (onboarding, signature validation, reference apps) and fallback options, and lays out a 6–8 week roadmap.  

## Target End Users  

- **Seller Operations Teams** at merchants or restaurant chains that receive ONDC orders. These teams need to monitor and troubleshoot orders in real time.  
- **Seller Network Participants (NPs)** who operate seller platforms or POS software for many merchants. For example, a cloud kitchen aggregator or a multi-brand restaurant group. They want visibility into all their inbound ONDC orders.  
- **Enterprise chains and marketplaces** on ONDC (e.g. a chain of hotels or grocery stores). They require both high-level metrics and the ability to drill into individual problematic orders.  

These users do *not* include end consumers. Instead of a consumer-facing order tracker, ONDC Pulse is a back-office tool. It helps merchants and NPs “see inside” the ONDC order flow: identify stuck or failing orders, find root causes, and take corrective action.  

## Scope and Differentiator  

**ONDC’s current observability** (per official sources) is at the network or participant level – e.g. confirmation rates, volumes, etc.. ONDC’s Network Observability program provides dashboards of **aggregate metrics** for the whole network and for each NP. For example, a participant can see “Attempt-to-Confirm rate = X%” or “Orders per hour”. However, these dashboards do **not** trace individual orders or reveal where exactly a transaction broke down.  

**ONDC Pulse** fills that gap by providing **transaction-level observability**. It ingests the raw ONDC messages (the “transaction logs”) from a participant’s system and rebuilds each order’s lifecycle. The system ensures *protocol compliance* (no out-of-order or duplicate messages), *timing guarantees* (SLA adherence between steps), and *end-to-end tracing*.  Thus ONDC Pulse is akin to “Datadog for ONDC orders” – it shows end-to-end event timelines and pinpoints failures. 

For example, an ONDC network dashboard might report that a participant’s confirm-success rate is 96%. ONDC Pulse would allow drilling into **which specific orders** failed to confirm and *why*. It would show a timeline: “Order #12345 – received confirm at 10:02:05, *no* logistics assignment by 10:04:05 (2m threshold) ⇒ SLA breach.” It would flag that incident, gather evidence, and even generate a human-readable explanation (via Bedrock) such as “The expected logistics-assignment message was not received for Order #12345 within the configured 2-minute window.” 

By working at the order level, ONDC Pulse enables very fast diagnostics. It can reconstruct exactly what went wrong (e.g. missing /on_confirm callback, or delayed /on_status) for each problematic order, rather than only reporting summary stats. This is the core differentiator versus existing ONDC network metrics. (Note: ONDC *does* mandate that participants submit transaction logs in JSON, and the reference apps support log submission, but those logs feed the *network’s* observability system, not something individual merchants can query. ONDC Pulse is designed to run *inside* a participant’s infrastructure and surface actionable insights to that participant’s operators.)  

## Key Features  

ONDC Pulse’s functionality can be grouped into several core components. Each is described below with purpose, I/O, data models, rules vs. AI, failure modes detected, and UI hints.  

- **1. Ingestion & Normalization:** Receives ONDC API callbacks (HTTP POST), authenticates and parses them. Input is the raw ONDC JSON (with its standard `context` and `message` structure). Output is a *canonical event* record (in a flattened, unified schema) stored in the database and raw JSON archived in S3.  
  - *Purpose:* Capture every relevant ONDC protocol message (e.g. /search, /select, /init, /confirm, /on_update, etc.) sent to the seller app, and transform it into a consistent internal format.  
  - *Inputs/Outputs:* Incoming payload example:  
    ```json  
    {  
      "context": {  
        "domain": "nic2004:60232", "action": "on_confirm",  
        "city": "std:080", "transaction_id": "tx-001", "timestamp": "2024-10-01T10:00:00Z",  
        "bpp_id": "SellerApp", "core_version": "1.2.0", ...  
      },  
      "message": {  
        "order": { "id": "ORDER123", "state": "Completed",  
                   "fulfillment": {"state": "Order-delivered"}, ... }  
      }  
    }  
    ```  
    Canonical event stored:  
    ```json
    {  
      "event_id": "evt-789",  
      "order_id": "ORDER123",  
      "event_time": "2024-10-01T10:00:00Z",  
      "event_type": "CONFIRM",  
      "role": "SELLER",  
      "payload": { ... }  
    }  
    ```  
  - *Data Model:* The database table `order_events` might have columns: `id, order_id, event_type, participant, timestamp, success_flag, raw_s3_uri, additional_data`.  
  - *Rules vs AI:* All ingestion logic is **deterministic** code. The Lambda verifies schema compliance and signature (if used), rejects bad input. No LLM/AI needed here.  
  - *Failure Modes Detected:* Invalid or malformed messages, failed signature check. These would raise an immediate error (logged and optionally alert).  
  - *UI/UX:* In the dashboard, raw event details might be viewable (e.g. JSON payload) for debugging. No direct user action is needed on ingestion itself.  

- **2. Order State Machine:** Tracks each order’s lifecycle and validates transitions. As canonical events stream in, this component updates the order’s current state. It ensures the sequence follows ONDC protocol rules.  
  - *Purpose:* Maintain the inferred state of each order (e.g. `{SEARCHED, SELECTED, INITIATED, CONFIRMED, ASSIGNED, PICKED_UP, OUT_FOR_DELIVERY, DELIVERED, CANCELLED}`) and detect unexpected sequences.  
  - *Inputs/Outputs:* Input is the sequence of canonical events for an order. Output is updated order state and possibly immediate detection of an inconsistency.  
  - *Data Model:* Table `orders` with columns: `order_id, current_state, last_event_time, last_event_type`. A state-transition definition (in code or config) defines valid moves.  
  - *Mermaid Example:*  
```mermaid
stateDiagram-v2
    [*] --> SEARCHED
    SEARCHED --> SELECTED
    SELECTED --> INITIATED
    INITIATED --> CONFIRMED
    CONFIRMED --> ASSIGNED
    ASSIGNED --> PICKED_UP
    PICKED_UP --> OUT_FOR_DELIVERY
    OUT_FOR_DELIVERY --> DELIVERED
    CONFIRMED --> CANCELLED
    SEARCHED --> CANCELLED
```
  - *Deterministic vs AI:* Entirely rule-based. No AI here. The code looks up the current state and the new event; if the transition is not allowed, it flags it.  
  - *Failure Modes Detected:* Out-of-order events (e.g. receiving *DELIVERED* before *PICKED_UP*), missing mandatory events (e.g. skipping *CONFIRMED*), duplicate events. These trigger incidents.  
  - *UI/UX:* The order timeline UI will highlight invalid transitions (e.g. show a red “❌” if a state is missing) or duplicates. The state machine logic feeds the SLA checks below.  

- **3. SLA Engine:** Measures time gaps between key milestones and checks against configured thresholds. E.g. time from CONFIRM to LOGISTICS_ASSIGNMENT.  
  - *Purpose:* Detect performance violations or delays. For example, if logistics isn’t assigned within 2 minutes of order confirmation, mark it.  
  - *Inputs/Outputs:* Inputs are timestamps of relevant events from the `order_events` table. Outputs are SLA-breach records/incidents.  
  - *Data Model:* A config table (or file) defines SLA rules, e.g.  
    ```json
    { "CONFIRM_TO_ASSIGN": { "threshold_sec": 120 } }
    ```  
    The system computes `delta = assign_time - confirm_time` and compares to threshold.  
  - *Deterministic vs AI:* Fully deterministic. It’s just math. No LLM use.  
  - *Failure Modes Detected:* Excess latency. Also possibly “stuck state” detection (if no next event arrives at all within a window).  
  - *UI/UX:* When an SLA rule is broken, the UI marks the timeline (e.g. “⚠ 5m02s > 2m SLA”). An incident appears in the dashboard.  

- **4. Incident Engine:** Correlates anomalies into incidents for alerting. It groups related order failures (e.g. many orders failing at the same step) and tracks ongoing issues.  
  - *Purpose:* Manage operator attention. Rather than alerting per-order, the system forms incident tickets (e.g. “Logistics callbacks failing for 15 orders since 2pm”).  
  - *Inputs/Outputs:* Inputs are raw failure signals (invalid transitions, SLA breaches) from the State Machine and SLA Engine. Outputs are records in an `incidents` table and SNS notifications/email.  
  - *Data Model:* Incidents table fields: `id, type, severity, affected_orders, created_at, last_updated, status`. It links to impacted orders.  
  - *Deterministic vs AI:* Mostly rules: e.g. “group if same failure type within 1 min into one incident.” AI not used for grouping.  
  - *Failure Modes Detected:* Repeated order failures (e.g. many confirm failures). This engine doesn’t *detect* new errors, but aggregates them.  
  - *UI/UX:* Incident list view: shows active incidents (type, severity). Clicking an incident shows details (affected orders, evidence). Buttons to “Resolve” or “Escalate.”  

- **5. Metrics & Tracing:** Computes aggregate metrics from the event stream. Examples include latencies (p50/p95/p99 for each stage), success/fail rates, and breakdowns by participant or API type. It also provides a “distributed trace” view per order.  
  - *Purpose:* Give higher-level insights and allow dashboards to plot metrics over time, and to drill into performance hotspots.  
  - *Inputs/Outputs:* Inputs are the canonical events and incidents. Outputs are time-series metrics. Could be stored in Amazon Timestream or computed on-demand with SQL.  
  - *Data Model:* Time-series measurements like `{"timestamp", "stage", "value", "participant"}`. For SQL, we might just query the `order_events` and `orders` tables with window functions.  
  - *Example Queries:*  
    ```sql
    -- P95 latency from CONFIRM to ASSIGNMENT (in seconds)
    SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (assign_time - confirm_time)))
      AS p95_confirm_to_assign
    FROM orders
    WHERE confirm_time IS NOT NULL AND assign_time IS NOT NULL;
    ```  
  - *UI/UX:* Dashboard charts: e.g. bar graphs of error rates by API type, time-series of median latency. Also drill-down tables.  
  - *Deterministic vs AI:* All quantitative. AI not used here.  

- **6. Replay / Simulation / Fault Injection:** Tools to generate or replay orders for testing. The system includes modes to inject delays or drop events.  
  - *Purpose:* Enable a live demo and testing environment. For example, one can click “Simulate order” or “Inject fault” to see the system react.  
  - *Inputs/Outputs:* Input toggles to cause the ingestion layer to suppress or delay certain events (e.g. skip the /on_status callback). Output is an artificial failure detected downstream.  
  - *Data Model:* Not a permanent data model – this is a “mode” in the pipeline. The system simply omits putting an event into the queue or adds a time.sleep.  
  - *Rules vs AI:* Purely deterministic simulation.  
  - *UI/UX:* A developer UI (or command interface) with checkboxes: “Drop Logistics Assignment callback” or “Delay Confirmation by 5 minutes”. The demo script then walks through these.  

- **7. AI Explanation (Bedrock):** Uses an LLM (via Amazon Bedrock) to produce human-readable incident summaries.  
  - *Purpose:* Help operators understand root causes quickly. It summarizes the evidence in plain English.  
  - *Inputs/Outputs:* Input is the structured incident data (timestamps, failure type, SLA breach times). Output is a text narrative.  
  - *Example:* Given evidence like “Order confirmed at 10:02, no logistics-assignment by 10:09 (SLA=2m)”, Bedrock might output: “Order #12345 was confirmed successfully, but the logistics assignment callback did not arrive within the 2-minute SLA. This likely caused the order delay.”  
  - *Deterministic vs AI:* This is the one “AI” component. Importantly, it does **not** detect issues (that's done by code). Bedrock only *rephrases* facts.  
  - *Failure Modes Detected:* None directly (the failures have already been detected). It just explains them.  
  - *UI/UX:* An “Explain” button next to each incident. On click, the AI-generated text appears in a details pane.  

## AWS Architecture  

The system is built entirely on serverless and managed AWS services. Below is a high-level architecture diagram (mermaid) showing the data flow and services.  

```mermaid
flowchart LR
  subgraph ONDC Network
    direction LR
    BuyerApp(Buyer App) -- ONDC API calls --> SellerApp(Seller Participant App)
  end
  subgraph AWS
    API(API Gateway) --> Ingest[Lambda: Ingest/Validate]
    Ingest --> S3[(S3 Raw Events Archive)]
    Ingest --> EventBus[EventBridge]
    EventBus --> SQS[(SQS Order Events Queue)]
    SQS --> Processor[Lambda: Order Processor]
    Processor --> Aurora[(Aurora PostgreSQL)]
    Processor --> IncidentEng[Lambda: Incident Engine]
    Processor --> MetricsEng[Lambda: Metrics Engine]
    MetricsEng --> Timestream[(Amazon Timestream)]
    IncidentEng --> Incidents[(Incidents Table)]
    Aurora --> Dashboard[Next.js UI on CloudFront]
    Dashboard --> Bedrock[Lambda → Amazon Bedrock]
    Bedrock --> Dashboard
    SNS[(SNS / Email Alerts)] --> Users{Ops Team Emails}
  end
```

**Service roles:**  
- **API Gateway (REST API):** Exposes endpoints (e.g. `/ondc/events`) for ONDC to POST callbacks. Handles TLS and can integrate with Cognito for a dashboard API.  
- **Lambda Ingestion:** Authorizes requests (e.g. using headers or AWS SigV4 if ONDC supports it), parses ONDC JSON, and writes it into **S3** (immutable raw archive) and emits a normalized event to EventBridge.  
- **Amazon S3:** Stores raw ONDC JSON events (for audit/forensics).  
- **Amazon EventBridge:** Routes normalized events to downstream consumers. A rule pushes all order events into an SQS queue. Alternatively, could route directly to Lambdas or Step Functions.  
- **Amazon SQS:** Durable queue buffering events. Ensures ordering per-shard (set up one SQS per participant or partition key).  
- **Lambda Order Processor:** Consumes from SQS (via event mapping). Updates `orders` and `order_events` in **Aurora PostgreSQL**. Checks for state transitions and SLA breaches. Emits alerts to Incident Engine if needed.  
- **Aurora PostgreSQL:** Stores the canonical data: orders, events, incidents, SLA rules. Chosen for relational queries and ACID consistency (needed for correct state updates and history).  
- **Lambda Incident Engine:** Triggered by Processor (or by database triggers) to group and record incidents into an `incidents` table. Sends notifications via **SNS**.  
- **Amazon SNS:** Notifies operators (email or SMS) when a critical incident is raised.  
- **Lambda Metrics Engine:** Periodically (or on event) updates time-series metrics in **Amazon Timestream** (or another store) and aggregates counters.  
- **Amazon Timestream (optional):** A time-series DB for high-scale metric queries. Used for computing P95/P99 latencies over time.  
- **Amazon Cognito:** Manages user authentication for the Next.js dashboard (ops users log in to see data).  
- **Next.js Dashboard:** Hosted (e.g. on AWS Amplify or CloudFront) as the UI. Calls AWS APIs (Lambda) to fetch data from Aurora/Timestream.  
- **Amazon Bedrock (via Lambda):** Invoked on-demand to explain incidents. Integrated through a dedicated Lambda or API call.  
- **AWS CDK / CloudFormation:** All resources are defined in infrastructure-as-code and deployed via a CI/CD pipeline. For example, a CodePipeline or CodeBuild can deploy the CDK stack and Lambda code.  

**Service Comparisons:**  

| Component         | Choice                                      | Alternatives and Trade-offs                                                 |
|-------------------|---------------------------------------------|------------------------------------------------------------------------------|
| **Compute/API**   | Lambda + API Gateway                        | Could use ECS/EKS (overkill for event-driven), Lambda is fully managed and scales on demand. |
| **Event Bus**     | EventBridge + SQS                           | SNS alone lacks queueing; Kinesis is for very high throughput (but more complex). EventBridge allows flexible routing. |
| **Datastore**     | Aurora PostgreSQL                           | DynamoDB (NoSQL) could scale more easily, but complex queries (e.g. correlations) favor SQL. RDS is simpler for relational logic. |
| **Metrics**       | Amazon Timestream (or CloudWatch metrics)   | For large-scale analytics, Timestream is optimized. Alternatively, store aggregates in Aurora (simpler for MVP). |
| **Orchestration** | (Optional) Step Functions for workflows     | Could use pure Lambdas; Step Functions adds visual workflow and retry, useful for incident escalation or batch tasks. |
| **Auth**         | API Gateway Cognito Authorizer              | Alternatively JWTs validated in Lambda. Cognito simplifies user management for the dashboard. |
| **UI Hosting**   | CloudFront/S3 (with Next.js) or AWS Amplify | Any static hostable solution works; AWS supports SPA hosting easily. |
| **CI/CD**        | AWS CDK + CodePipeline/CodeBuild            | Could use Terraform/Jenkins; CDK integrates nicely with AWS and supports TypeScript/JS stacks. |

A minimal demo could skip some (e.g. one Lambda for both ingest and processing) and use a simpler DB (even DynamoDB or SQLite), but a production design uses the above scalable components.  

## Integration with ONDC Pre-Production  

To test with real orders, ONDC Pulse should integrate with ONDC’s staging environment: 

1. **Onboarding:** Register as a **Seller Network Participant** in ONDC’s developer portal. For pre-production, ONDC provides a reference seller app URL; one typically emails `team@ondc.org` to receive credentials and sandbox endpoints (as indicated by ONDC’s docs).  For example, the documentation lists a Pre-Prod buyer app URL and notes *“Email team@ondc.org to get the required support.”*. (Hackathon teams can skip formalities by using generic “buyer” and “seller” URLs shown in the ONDC GitHub, but production usage requires official enrollment.)  

2. **Reference Apps:** ONDC provides a **Reference Buyer App** in pre-production. This app can simulate a consumer placing an order (search→select→confirm) against your Seller App.  You run your seller’s callback endpoint (the API Gateway) and point the reference buyer to it.  This yields *real ONDC protocol traffic* to consume. ONDC recommends end-to-end testing with the reference apps. 

3. **API Authentication:** ONDC uses the Beckn protocol. In practice, each message includes a `context` with fields like `bpp_id` and is often accompanied by a signature header or token. The exact mechanism (e.g. HTTPS mutual TLS or JSON Web Signature) depends on ONDC config. For a hackathon demo, you can disable strict signature checking or use sample keys. At minimum, validate the sender ID (`context.bpp_id`). 

4. **Reference Flows:** Follow ONDC’s workflow as per the Retail B2C spec. Your Seller App (or ONDC Pulse ingestion endpoint) must accept calls for `/on_search`, `/on_select`, `/on_init`, `/on_confirm`, `/on_update`, etc. Start by implementing *confirm* and *on_confirm*, since the example pipeline typically goes: the Buyer app hits your `/select`, you respond, then `/init`, `/confirm` and so on. The ONDC Workbench and Test Scenarios (B2C v1.2) can guide which calls to handle. 

5. **Transaction Logs:** For pre-production integration, you might not need to submit logs to ONDC. (In production, ONDC requires JSON logs within 15 minutes). But even in staging, your system will capture the same events for its own use.  

6. **Fallback / Replay:** If getting onto ONDC pre-prod is delayed, have a fallback: a *replay harness*. For example, store a few sample ONDC JSON event sequences (extracted from logs or docs) and load them via a script into the API Gateway or directly to the ingestion Lambda. This lets you test the pipeline without live ONDC. For demo, synthetic or recorded sequences of, say, 3 complete orders (one normal, one with delayed callback, one with missing event) can suffice. 

## Real Order Data & Access  

- **ONDC Pre-Prod:** The easiest “real data” is from ONDC’s own pre-production network (reference buyer + your seller endpoint). These are genuine order flows, just not customer data. This is fully supported for testing.  

- **ONDC Production Participants (Magicpin, EatSure, etc):** Companies like Magicpin are indeed ONDC Seller NPs, but their live order data isn’t publicly available via an open API. Without a formal partnership and API contract, you cannot pull their production data. Thus, real production orders from existing apps are *not* accessible for development.  

- **Third-party Apps:** Likewise, even if Paytm or Dunzo are ONDC buyers, they do not publish order streams. We do not rely on those.  

- **Data Access Caveats:** All ONDC data is governed by privacy rules (the Transaction Logs policy prohibits sharing PII). Our prototype only needs synthetic or anonymized events.  

In summary: **Develop with ONDC’s sandbox/preprod environment**. Use reference apps or a simple replay. Do *not* expect to integrate live with any established marketplace's orders in a hackathon timeframe.  

## Fault Injection and Demo Script  

To showcase incident detection, we’ll include a fault injection mode. For example: 

- **Drop Event:** Option to deliberately ignore (not forward) the `/on_status` (logistics assignment) callback in ingestion.  
- **Delay Event:** Option to pause forwarding an event by X seconds (e.g. delay `/on_confirm` by 5 minutes).  
- **Duplicate/Out-of-Order:** Option to send the same event twice or in a scrambled order.  

**Demo Steps:**  
1. **Setup:** Deploy ONDC Pulse (see CI/CD below). Acquire ONDC preprod credentials. Configure the Seller App endpoint URL in the reference buyer app.  
2. **Normal Flow:** Trigger an order via the Buyer app. Monitor ONDC Pulse: the order timeline should show all steps (SEARCH→SELECT→INIT→CONFIRM→…→DELIVERED) and “No incidents.” The dashboard shows high reliability.  
3. **Inject Fault:** Activate the fault toggle (e.g. “Drop Logistics Assignment”). Place another order. The buyer will complete payment/confirm, but our system will never receive `/on_status`.  
4. **Detect & Alert:** After the SLA threshold (e.g. 2 minutes) passes, ONDC Pulse flags “Logistics assignment missing,” creates an incident, and perhaps sends an alert. The dashboard highlights the order as “STUCK at Confirmed.”  
5. **Explain & Resolve:** Click “Explain Incident” – the AI text appears (“No logistics callback received within SLA”). Show how the operator can then call the logistics provider or retry.  
6. **Other Scenarios:** Repeat with “Delay Confirm” and “Duplicate Confirm” to show detection of out-of-order or repeated events.  

By following this script, the judges will see the full end-to-end value: actual protocol traffic, real-time processing, and system response to failures.  

## Telemetry and Metrics  

Important metrics and queries include:  

- **Latency Percentiles (p50/p95/p99):** e.g. confirmation→assignment time. Can be queried in SQL or in Timestream.  
- **SLA Breach Rate:** Percentage of orders violating each SLA.  
- **Success/Failure Rates:** e.g. `/select` succeeded vs failed count, `/confirm` success rate.  
- **Per-Participant Breakdown:** If multiple logistics providers, show each provider’s error or latency stats.  
- **Traffic Volume:** Orders per minute, etc.  

*Example SQL (Aurora):*  
```sql
-- Compute 95th percentile for Confirm→Assignment latency (seconds)
SELECT 
  percentile_cont(0.95) 
    WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (assign_time - confirm_time))) 
  AS p95_secs
FROM orders 
WHERE confirm_time IS NOT NULL 
  AND assign_time IS NOT NULL;
```

*Time-series Queries (Timestream):* store metrics as (timestamp, metric_name, value, tag=participant). Then get sliding-window stats or alarms in CloudWatch. 

The dashboard can display these metrics in charts. Alerts can be added (e.g. CloudWatch alarm if p95 latency exceeds a threshold).  

## Data Models and Schemas  

- **Raw ONDC JSON (example):** The system archives each message, e.g.:  
  ```json
  {
    "context": {
      "domain": "nic2004:60232",
      "action": "on_confirm",
      "country": "IND",
      "city": "std:080",
      "transaction_id": "tx-001",
      "message_id": "msg-123",
      "timestamp": "2024-10-01T10:00:00Z",
      "bpp_id": "seller-app-preprod",
      "bpp_uri": "https://example-seller/api/ondc"
    },
    "message": {
      "order": {
        "id": "ORDER123",
        "state": "Completed",
        "billing": { "email": "alice@example.com", "phone": "0123456789" },
        "fulfillment": { "type": "HOME-DELIVERY", "tracking": "ORDER-DELIVERED" }
      }
    }
  }
  ```
- **Canonical Event Schema (example):** After parsing, events are stored in a unified form, e.g.:  
  ```json
  {
    "event_id": "evt-789",
    "order_id": "ORDER123",
    "transaction_id": "tx-001",
    "event_time": "2024-10-01T10:00:00Z",
    "event_type": "CONFIRM",
    "participant_id": "seller-app-preprod",
    "participant_role": "SELLER",
    "payload": {
      "items": [ { "id": "item1", "qty": 2, "price": 18.50 } ],
      "total_value": 37.00,
      "fulfillment_status": "Initiated"
    }
  }
  ```

The relational schema includes tables: `orders`, `order_events`, `sla_rules`, `incidents`, `users` (for login), etc. We would use foreign keys (e.g. `order_events.order_id` → `orders.id`).  

## Deployment & CI/CD  

All infrastructure and code should be automated:  

- **Infrastructure as Code:** Use AWS CDK (TypeScript or Python) to define the stack. This includes the API Gateway, Lambdas, SQS, EventBridge rules, Aurora cluster, Cognito User Pool, etc. Version control the CDK code.  
- **Continuous Integration:** On each commit or PR, run CI to lint/test code and synthesize the CDK templates. (GitHub Actions or AWS CodeBuild can do this.)  
- **Continuous Deployment:** A CodePipeline or GitHub Actions workflow can deploy the stack on merge to main. It installs CDK, `cdk deploy`, and also builds/pushes the Next.js dashboard (e.g. to S3/CloudFront).  
- **Testing:** Unit-tests for state machine logic (e.g. a Jest or PyTest suite feeding sample events and checking state transitions). Integration tests could use AWS SAM or localstack to simulate Lambda triggers.  
- **Monitoring:** Use CloudWatch Logs and Metrics for all Lambdas. Configure alerts (SNS) on Lambda errors or high throttling.  

This approach ensures we can deploy updates quickly. For a 48-hour hackathon, one might mock out some AWS (or deploy to a free tier) and simplify, but for a production-ready design we assume CDK and pipelines are in place.  

## Key Risks & Mitigations  

- **Data Access / Integration Risk:** Real ONDC orders (esp. production merchants) are not freely available. *Mitigation:* Rely on pre-production testing and synthetic data. Document that real deployment would require proper ONDC NP onboarding. Emphasize that ONDC Pulse’s core logic works identically on test or live data (just feed it real events).  
- **Authentication & Security:** Handling ONDC authentication (signatures, keys) can be complex. *Mitigation:* For MVP, simplify or bypass strict checks (assuming pre-prod test tokens). For production, implement Beckn signature verification as per spec. Use API Gateway’s built-in authorizers or Lambda code for token verification.  
- **Scalability:** A highly popular seller could generate thousands of orders/sec. *Mitigation:* The use of EventBridge/SQS and Lambda (which autoscale) handles burst. Aurora can scale to moderate throughput; for extreme scale consider Aurora Serverless or sharding. Use DAX or read replicas for heavy reads.  
- **Schema Drift:** ONDC specifications can change. *Mitigation:* Keep ingestion and normalization loosely coupled. The canonical schema should be flexible (e.g. a JSONB column for `payload`). Use the ONDC Workbench to catch breaking changes early.  
- **Data Privacy:** Ensure personal data (PII) is not stored by Pulse (or is encrypted). As ONDC requires removing PII when submitting logs, we should follow that too. For demo we only use synthetic data or anonymize it.  
- **Single Point of Failure:** If the dashboard is down, operators lose visibility. *Mitigation:* Host the frontend on a highly available service (CloudFront) and keep the backend stateless and replicated.  

## Roadmap (6–8 Weeks)  

1. **Week 1 – Foundations:** Set up AWS accounts and CDK project. Deploy base stack (API Gateway, simple Lambda, Aurora). Build ingestion Lambda to store one sample event in DB.  
2. **Week 2 – Canonical Model & Storage:** Define the canonical event schema. Implement Lambda parsing raw ONDC JSON into that schema, store in `order_events` table, archive raw JSON in S3. Write unit tests for event normalization.  
3. **Week 3 – State Machine Engine:** Add logic to update `orders.current_state` per event. Implement checks for invalid transitions. Test with sample sequences.  
4. **Week 4 – SLA Logic & Incidents:** Develop SLA rules (e.g. confirm→assign). Integrate comparison logic after each relevant event. Create `incidents` table and incident logic. Hook up SNS alerts for critical incidents.  
5. **Week 5 – Dashboard UI:** Build Next.js app skeleton. Implement login (Cognito). Create views: Order Timeline (reads from Aurora), Incidents list. Show live sample data. Deploy to S3/CloudFront.  
6. **Week 6 – Metrics & Charts:** Add metrics engine (store metrics in Timestream or SQL). Add dashboard charts (latency trends, error rates). Implement drill-down on partitions (by seller).  
7. **Week 7 – Fault Injection & Replay:** Add a UI or endpoint to toggle fault modes. Test various failure scenarios. Refine incident grouping. Improve UX (e.g. update "stuck" statuses in real time).  
8. **Week 8 – Polishing & Documentation:** Integrate Amazon Bedrock for explanations. Optimize performance. Write final documentation. Set up CI/CD pipelines.  

**48–72h Hackathon Slice:** Focus on a vertical slice. Steps:  
- Deploy minimal infra (Gateway → Lambda → Aurora).  
- Ingest a static sample order sequence (hardcoded events).  
- Show a basic web page listing one order’s timeline from DB.  
- Add one failure (simulate missing event) and detect it.  
This proves the core concept end-to-end quickly. Later weeks add the bells & whistles.  

## Summary Tables  

**Service Comparison:**  

| Component        | Selected Service              | Rationale                                                    |
|------------------|-------------------------------|--------------------------------------------------------------|
| API Interface    | Amazon API Gateway            | Secures and scales HTTP endpoints for ONDC callbacks.        |
| Compute          | AWS Lambda                    | Fully managed, auto-scaling event handlers (Ingest, Process).|
| Queue/Event Bus  | Amazon EventBridge + SQS      | Flexible routing (EventBridge) plus durable queueing (SQS).  |
| Database         | Amazon Aurora PostgreSQL      | Strong relational queries (joins, analytics) on order data.  |
| Metrics         | Amazon Timestream (optional)  | High-scale time-series analytics for SLA latency data.|
| Authentication   | Amazon Cognito                | User management for dashboard; integrates with API GW.       |
| Workflow         | AWS Step Functions (optional) | For complex incident workflows (retry, orchestration).       |
| Frontend Hosting | Amazon CloudFront + S3        | Fast, global CDN for React/Next.js dashboard.                |
| AI/ML           | Amazon Bedrock               | Explain incidents in natural language.                       |

**Data Source Options:**  

| Source                         | Real Orders? | Access Method                  | Notes                                      |
|--------------------------------|--------------|--------------------------------|--------------------------------------------|
| ONDC Pre-Prod Reference Buyer  | Yes          | ONDC Test Network (API)       | Requires ONDC sandbox sign-up; real protocol flows. |
| Magicpin (production orders)   | Yes          | *Not open* (internal)         | No public API; would need partnership.     |
| Synthetic / Replay Logs        | No           | Custom data files/script      | Always available for testing/demo.         |

**Feature Priorities:**  

| Feature                    | Hackathon Priority | Production Priority | Notes                       |
|----------------------------|--------------------|---------------------|-----------------------------|
| Ingestion & Normalization  | High               | High                | Core pipeline.              |
| Order State Machine        | High               | High                | Core logic.                 |
| SLA & Incident Engine      | High               | High                | Detect failures.            |
| Order Tracing UI           | Medium             | High                | Visual proof-of-concept.    |
| Fault Injection/Replay     | High (demo)        | Low (internal)      | Critical for demo success.  |
| Metrics & Dashboard Charts | Medium             | Medium              | Nice to have analytics.     |
| AI Explanation (Bedrock)   | Low                | Low/Optional        | Helpful for UX, not core.   |

These tables and diagrams summarize key design decisions.  

**Citations:** ONDC’s own documentation confirms the existing observability scope (network/participant metrics) and log-submission requirements. Amazon Timestream’s service description highlights its ability to ingest and query large volumes of time-series data (useful for our latency metrics).  

This design lays out a concrete AWS solution for ONDC Pulse, bridging ONDC’s open-protocol data with an actionable observability platform for merchants.
