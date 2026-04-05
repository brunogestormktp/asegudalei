# Integration Guide for AI Assistant

## Overview

The AI Assistant is a new feature integrated into "A Segunda Lei" that provides users with an interactive chat interface powered by AI. This guide outlines the steps required to integrate the AI Assistant into your existing application.

## Prerequisites

Before integrating the AI Assistant, ensure that you have the following:

- Access to the Supabase project where your application is hosted.
- An OpenRouter API key for AI interactions.
- Basic knowledge of JavaScript, HTML, and CSS.

## Setup Instructions

### 1. Supabase Edge Function

The AI Assistant functionality is powered by an Edge Function located at `supabase/functions/ai-assistant/index.ts`. This function handles requests from the AI Assistant tab, including:

- JWT authentication
- CORS handling
- Rate limiting
- Interaction with the OpenRouter API

To deploy the Edge Function:

1. Navigate to the Supabase dashboard.
2. Go to the "Functions" section.
3. Create a new function and copy the contents of `index.ts` into the function editor.
4. Set up the necessary environment variables, including your OpenRouter API key.

### 2. Type Definitions

Ensure that the type definitions for the Edge Function are correctly set up. The types can be found in `supabase/functions/ai-assistant/types.ts`. This file defines the TypeScript types and interfaces used in the Edge Function.

### 3. JavaScript Mixin

The AI Assistant functionality is implemented in `js/features/app-ai-assistant.js`. This file manages the state of the AI chat and handles user interactions. To integrate the mixin:

1. Import the mixin into your main application JavaScript file.
2. Initialize the AI Assistant by calling the appropriate methods to render the chat interface.

### 4. HTML Structure

The HTML structure for the AI Assistant tab is defined in `templates/ai-assistant-tab.html`. To include the AI Assistant in your application:

1. Add a navigation button to access the AI Assistant tab.
2. Include the chat interface and input area as defined in the HTML template.

### 5. CSS Styles

The styles for the AI Assistant tab are located in `css/ai-assistant.css`. Ensure that this CSS file is linked in your main HTML file to apply the necessary styles for the chat interface.

## Usage Examples

### Sending a Message

To send a message to the AI Assistant, use the following method from the mixin:

```javascript
aiAssistant.sendMessage(userInput);
```

### Receiving a Response

The AI Assistant will process the user input and return a response. You can handle the response as follows:

```javascript
aiAssistant.onResponse((response) => {
    // Update the chat interface with the AI response
});
```

## Conclusion

Integrating the AI Assistant into "A Segunda Lei" enhances user interaction and provides a modern chat experience. Follow the steps outlined in this guide to successfully implement the feature. For further assistance, refer to the README.md file or contact the development team.