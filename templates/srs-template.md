# SRS Template — Generic English Example

> **Note for authors:** You may write your actual SRS in any language —
> the sd-author reads `config.language` and generates the Solution Design
> accordingly. This shipped template is a neutral English example only.

# **Feature: {{Feature name}} — {{System name}}**

# **I. Main Content**

## **1. Summary**

| Version | Author | Date | Change Summary |
| --- | --- | --- | --- |
|  |  |  |  |

- **Feature scope:** \<List the capabilities included in this feature>
- **Target users:** \<List the user roles or surfaces that interact with this feature>
- **Terminology:**

| Term | Definition |
| --- | --- |
|  |  |

## **2. Sequence Diagram**

\<Draw a high-level diagram showing the interactions and data flows between
actors, services, and components involved in this feature>

## **3. State Machine**

\<Draw the overall state diagram for this feature, and provide a table
describing the meaning of each state>

## **4. User Stories**

### US-1: \<Story name>

- As a \<role>,
- I want to \<action>,
- So that I can \<outcome>.

#### Acceptance Criteria

List the conditions that must be true for this story to be considered complete.
Write each one as its own bullet, phrased so QA can verify it independently —
**each bullet becomes one FR row plus its TC row**, so a paragraph here means a
requirement the harvest cannot see. Replace these examples:

- The operator can submit the form and receives a confirmation within 2 seconds.
- A submission that fails validation is rejected with a field-level error message.
- A duplicate submission within the idempotency window returns the original result.

#### Edge Cases

Uncommon or boundary scenarios QA should also cover. One bullet each — these
become TC rows too. Replace these examples:

- The upstream service times out mid-submission.
- The same record is submitted concurrently from two sessions.

## **5. Functional Requirements**

### **5.1. User Journey**

\<Describe how a user discovers and navigates through this feature, step by step>

### **5.2. Frontend Requirements**

\<Group requirements by surface (e.g. Admin Portal, End-User App, Operator
Dashboard). For each surface describe the screens and UI behaviours the user
interacts with directly.>

**Screen 1: \<Screen / view name>**

- **Purpose:**
- **Location in the app:**

| Label | Display type | Input type | Mandatory | Notes |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

- **Wireframe:**
\<Attach or embed a wireframe that matches the functional requirements above>

### **5.3. Business Logic**

\<Describe the processing rules, validation logic, calculation formulas, and
workflow conditions that the backend must enforce. Number each rule so they
can be traced to test cases.>

**BL-1:** \<Rule description>

**BL-2:** \<Rule description>

## **6. Non-Functional Requirements**

### **6.1. Security & Performance**

\<Table of NFR targets and how they will be measured>

| ID | Requirement | Target | Measurement method |
| --- | --- | --- | --- |
| NFR-1 | Response time (p99) |  |  |
| NFR-2 | Throughput |  |  |
| NFR-3 | Authentication / authorisation |  |  |
| NFR-4 | Data encryption |  |  |

### **6.2. Error & Notification Messages**

\<Tables describing error codes, warning messages, informational notices, and
any out-of-band notifications (email, SMS, in-app alert, etc.). Keep wording
concise and user-friendly.>

| Code / trigger | Message text | Channel | Audience |
| --- | --- | --- | --- |
|  |  |  |  |

# **II. Appendix**

\<Any additional detail that did not fit naturally in Part I — reference data,
third-party API contracts, regulatory references, open questions, etc.>
