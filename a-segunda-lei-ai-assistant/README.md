# AI Assistant for A Segunda Lei

This project adds a minimalist AI Assistant tab to the existing app "A Segunda Lei." The AI Assistant leverages an Edge Function to provide intelligent responses and actions based on user input.

## Project Structure

```
a-segunda-lei-ai-assistant
├── supabase
│   └── functions
│       └── ai-assistant
│           ├── index.ts          # Edge Function handling AI Assistant requests
│           └── types.ts          # TypeScript types and interfaces for the Edge Function
├── js
│   └── features
│       └── app-ai-assistant.js    # JavaScript mixin for managing AI Assistant state and interactions
├── css
│   └── ai-assistant.css           # CSS styles for the AI Assistant tab
├── templates
│   └── ai-assistant-tab.html      # HTML structure for the AI Assistant tab
├── docs
│   └── integration-guide.md       # Documentation for integrating the AI Assistant
└── README.md                      # Project overview and installation instructions
```

## Installation

1. Clone the repository:
   ```
   git clone <repository-url>
   cd a-segunda-lei-ai-assistant
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Set up Supabase and deploy the Edge Function:
   - Follow the instructions in `docs/integration-guide.md` for setting up the Supabase functions.

## Usage

- Navigate to the AI Assistant tab in the app to start interacting with the AI.
- The AI Assistant will respond to user queries and provide actionable insights.

## Development

- The Edge Function is located in `supabase/functions/ai-assistant/index.ts`.
- The JavaScript mixin for the AI Assistant is in `js/features/app-ai-assistant.js`.
- CSS styles can be modified in `css/ai-assistant.css`.
- The HTML structure is defined in `templates/ai-assistant-tab.html`.

## Contributing

Contributions are welcome! Please submit a pull request or open an issue for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.