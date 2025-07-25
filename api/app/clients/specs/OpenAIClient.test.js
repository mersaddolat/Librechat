jest.mock('~/cache/getLogStores');
require('dotenv').config();
const { fetchEventSource } = require('@waylaidwanderer/fetch-event-source');
const getLogStores = require('~/cache/getLogStores');
const OpenAIClient = require('../OpenAIClient');
jest.mock('meilisearch');

jest.mock('~/db/connect');
jest.mock('~/models', () => ({
  User: jest.fn(),
  Key: jest.fn(),
  Session: jest.fn(),
  Balance: jest.fn(),
  Transaction: jest.fn(),
  getMessages: jest.fn().mockResolvedValue([]),
  saveMessage: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessagesSince: jest.fn(),
  deleteMessages: jest.fn(),
  getConvoTitle: jest.fn(),
  getConvo: jest.fn(),
  saveConvo: jest.fn(),
  deleteConvos: jest.fn(),
  getPreset: jest.fn(),
  getPresets: jest.fn(),
  savePreset: jest.fn(),
  deletePresets: jest.fn(),
  findFileById: jest.fn(),
  createFile: jest.fn(),
  updateFile: jest.fn(),
  deleteFile: jest.fn(),
  deleteFiles: jest.fn(),
  getFiles: jest.fn(),
  updateFileUsage: jest.fn(),
}));

// Import the actual module but mock specific parts
const agents = jest.requireActual('@librechat/agents');
const { CustomOpenAIClient } = agents;

// Also mock ChatOpenAI to prevent real API calls
agents.ChatOpenAI = jest.fn().mockImplementation(() => {
  return {};
});
agents.AzureChatOpenAI = jest.fn().mockImplementation(() => {
  return {};
});

// Mock only the CustomOpenAIClient constructor
jest.spyOn(CustomOpenAIClient, 'constructor').mockImplementation(function (...options) {
  return new CustomOpenAIClient(...options);
});

const finalChatCompletion = jest.fn().mockResolvedValue({
  choices: [
    {
      message: { role: 'assistant', content: 'Mock message content' },
      finish_reason: 'Mock finish reason',
    },
  ],
});

const stream = jest.fn().mockImplementation(() => {
  let isDone = false;
  let isError = false;
  let errorCallback = null;

  const onEventHandlers = {
    abort: () => {
      // Mock abort behavior
    },
    error: (callback) => {
      errorCallback = callback; // Save the error callback for later use
    },
    finalMessage: (callback) => {
      callback({ role: 'assistant', content: 'Mock Response' });
      isDone = true; // Set stream to done
    },
  };

  const mockStream = {
    on: jest.fn((event, callback) => {
      if (onEventHandlers[event]) {
        onEventHandlers[event](callback);
      }
      return mockStream;
    }),
    finalChatCompletion,
    controller: { abort: jest.fn() },
    triggerError: () => {
      isError = true;
      if (errorCallback) {
        errorCallback(new Error('Mock error'));
      }
    },
    [Symbol.asyncIterator]: () => {
      return {
        next: () => {
          if (isError) {
            return Promise.reject(new Error('Mock error'));
          }
          if (isDone) {
            return Promise.resolve({ done: true });
          }
          const chunk = { choices: [{ delta: { content: 'Mock chunk' } }] };
          return Promise.resolve({ value: chunk, done: false });
        },
      };
    },
  };
  return mockStream;
});

const create = jest.fn().mockResolvedValue({
  choices: [
    {
      message: { content: 'Mock message content' },
      finish_reason: 'Mock finish reason',
    },
  ],
});

// Mock the implementation of CustomOpenAIClient instances
jest.spyOn(CustomOpenAIClient.prototype, 'constructor').mockImplementation(function () {
  return this;
});

// Create a mock for the CustomOpenAIClient class
const mockCustomOpenAIClient = jest.fn().mockImplementation(() => ({
  beta: {
    chat: {
      completions: {
        stream,
      },
    },
  },
  chat: {
    completions: {
      create,
    },
  },
}));

CustomOpenAIClient.mockImplementation = mockCustomOpenAIClient;

describe('OpenAIClient', () => {
  beforeEach(() => {
    const mockCache = {
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn(),
    };
    getLogStores.mockReturnValue(mockCache);
  });
  let client;
  const model = 'gpt-4';
  const parentMessageId = '1';
  const messages = [
    { role: 'user', sender: 'User', text: 'Hello', messageId: parentMessageId },
    { role: 'assistant', sender: 'Assistant', text: 'Hi', messageId: '2' },
  ];

  const defaultOptions = {
    // debug: true,
    req: {},
    openaiApiKey: 'new-api-key',
    modelOptions: {
      model,
      temperature: 0.7,
    },
  };

  const defaultAzureOptions = {
    azureOpenAIApiInstanceName: 'your-instance-name',
    azureOpenAIApiDeploymentName: 'your-deployment-name',
    azureOpenAIApiVersion: '2020-07-01-preview',
  };

  let originalWarn;

  beforeAll(() => {
    originalWarn = console.warn;
    console.warn = jest.fn();
  });

  afterAll(() => {
    console.warn = originalWarn;
  });

  beforeEach(() => {
    console.warn.mockClear();
  });

  beforeEach(() => {
    const options = { ...defaultOptions };
    client = new OpenAIClient('test-api-key', options);
    client.summarizeMessages = jest.fn().mockResolvedValue({
      role: 'assistant',
      content: 'Refined answer',
      tokenCount: 30,
    });
    client.buildPrompt = jest
      .fn()
      .mockResolvedValue({ prompt: messages.map((m) => m.text).join('\n') });
    client.getMessages = jest.fn().mockResolvedValue([]);
  });

  describe('setOptions', () => {
    it('should set the options correctly', () => {
      expect(client.apiKey).toBe('new-api-key');
      expect(client.modelOptions.model).toBe(model);
      expect(client.modelOptions.temperature).toBe(0.7);
    });

    it('should set FORCE_PROMPT based on OPENAI_FORCE_PROMPT or reverseProxyUrl', () => {
      process.env.OPENAI_FORCE_PROMPT = 'true';
      client.setOptions({});
      expect(client.FORCE_PROMPT).toBe(true);
      delete process.env.OPENAI_FORCE_PROMPT; // Cleanup
      client.FORCE_PROMPT = undefined;

      client.setOptions({ reverseProxyUrl: 'https://example.com/completions' });
      expect(client.FORCE_PROMPT).toBe(true);
      client.FORCE_PROMPT = undefined;

      client.setOptions({ reverseProxyUrl: 'https://example.com/chat' });
      expect(client.FORCE_PROMPT).toBe(false);
    });

    it('should set isChatCompletion based on useOpenRouter, reverseProxyUrl, or model', () => {
      client.setOptions({ reverseProxyUrl: null });
      // true by default since default model will be gpt-4o-mini
      expect(client.isChatCompletion).toBe(true);
      client.isChatCompletion = undefined;

      // false because completions url will force prompt payload
      client.setOptions({ reverseProxyUrl: 'https://example.com/completions' });
      expect(client.isChatCompletion).toBe(false);
      client.isChatCompletion = undefined;

      client.setOptions({ modelOptions: { model: 'gpt-4o-mini' }, reverseProxyUrl: null });
      expect(client.isChatCompletion).toBe(true);
    });

    it('should set completionsUrl and langchainProxy based on reverseProxyUrl', () => {
      client.setOptions({ reverseProxyUrl: 'https://localhost:8080/v1/chat/completions' });
      expect(client.completionsUrl).toBe('https://localhost:8080/v1/chat/completions');
      expect(client.langchainProxy).toBe('https://localhost:8080/v1');

      client.setOptions({ reverseProxyUrl: 'https://example.com/completions' });
      expect(client.completionsUrl).toBe('https://example.com/completions');
      expect(client.langchainProxy).toBe('https://example.com/completions');
    });
  });

  describe('setOptions with Simplified Azure Integration', () => {
    afterEach(() => {
      delete process.env.AZURE_OPENAI_DEFAULT_MODEL;
      delete process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME;
    });

    const azureOpenAIApiInstanceName = 'test-instance';
    const azureOpenAIApiDeploymentName = 'test-deployment';
    const azureOpenAIApiVersion = '2020-07-01-preview';

    const createOptions = (model) => ({
      modelOptions: { model },
      azure: {
        azureOpenAIApiInstanceName,
        azureOpenAIApiDeploymentName,
        azureOpenAIApiVersion,
      },
    });

    it('should set model from AZURE_OPENAI_DEFAULT_MODEL when Azure is enabled', () => {
      process.env.AZURE_OPENAI_DEFAULT_MODEL = 'gpt-4-azure';
      const options = createOptions('test');
      client.azure = options.azure;
      client.setOptions(options);
      expect(client.modelOptions.model).toBe('gpt-4-azure');
    });

    it('should not change model if Azure is not enabled', () => {
      process.env.AZURE_OPENAI_DEFAULT_MODEL = 'gpt-4-azure';
      const originalModel = 'test';
      client.azure = false;
      client.setOptions(createOptions('test'));
      expect(client.modelOptions.model).toBe(originalModel);
    });

    it('should not change model if AZURE_OPENAI_DEFAULT_MODEL is not set and model is passed', () => {
      const originalModel = 'GROK-LLM';
      const options = createOptions(originalModel);
      client.azure = options.azure;
      client.setOptions(options);
      expect(client.modelOptions.model).toBe(originalModel);
    });

    it('should change model if AZURE_OPENAI_DEFAULT_MODEL is set and model is passed', () => {
      process.env.AZURE_OPENAI_DEFAULT_MODEL = 'gpt-4-azure';
      const originalModel = 'GROK-LLM';
      const options = createOptions(originalModel);
      client.azure = options.azure;
      client.setOptions(options);
      expect(client.modelOptions.model).toBe(process.env.AZURE_OPENAI_DEFAULT_MODEL);
    });

    it('should include model in deployment name if AZURE_USE_MODEL_AS_DEPLOYMENT_NAME is set', () => {
      process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME = 'true';
      const model = 'gpt-4-azure';

      const AzureClient = new OpenAIClient('test-api-key', createOptions(model));

      const expectedValue = `https://${azureOpenAIApiInstanceName}.openai.azure.com/openai/deployments/${model}/chat/completions?api-version=${azureOpenAIApiVersion}`;

      expect(AzureClient.modelOptions.model).toBe(model);
      expect(AzureClient.azureEndpoint).toBe(expectedValue);
    });

    it('should include model in deployment name if AZURE_USE_MODEL_AS_DEPLOYMENT_NAME and default model is set', () => {
      const defaultModel = 'gpt-4-azure';
      process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME = 'true';
      process.env.AZURE_OPENAI_DEFAULT_MODEL = defaultModel;
      const model = 'gpt-4-this-is-a-test-model-name';

      const AzureClient = new OpenAIClient('test-api-key', createOptions(model));

      const expectedValue = `https://${azureOpenAIApiInstanceName}.openai.azure.com/openai/deployments/${model}/chat/completions?api-version=${azureOpenAIApiVersion}`;

      expect(AzureClient.modelOptions.model).toBe(defaultModel);
      expect(AzureClient.azureEndpoint).toBe(expectedValue);
    });

    it('should not include model in deployment name if AZURE_USE_MODEL_AS_DEPLOYMENT_NAME is not set', () => {
      const model = 'gpt-4-azure';

      const AzureClient = new OpenAIClient('test-api-key', createOptions(model));

      const expectedValue = `https://${azureOpenAIApiInstanceName}.openai.azure.com/openai/deployments/${azureOpenAIApiDeploymentName}/chat/completions?api-version=${azureOpenAIApiVersion}`;

      expect(AzureClient.modelOptions.model).toBe(model);
      expect(AzureClient.azureEndpoint).toBe(expectedValue);
    });
  });

  describe('getTokenCount', () => {
    it('should return the correct token count', () => {
      const count = client.getTokenCount('Hello, world!');
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('getSaveOptions', () => {
    it('should return the correct save options', () => {
      const options = client.getSaveOptions();
      expect(options).toHaveProperty('chatGptLabel');
      expect(options).toHaveProperty('modelLabel');
      expect(options).toHaveProperty('promptPrefix');
    });
  });

  describe('getBuildMessagesOptions', () => {
    it('should return the correct build messages options', () => {
      const options = client.getBuildMessagesOptions({ promptPrefix: 'Hello' });
      expect(options).toHaveProperty('isChatCompletion');
      expect(options).toHaveProperty('promptPrefix');
      expect(options.promptPrefix).toBe('Hello');
    });
  });

  describe('buildMessages', () => {
    it('should build messages correctly for chat completion', async () => {
      const result = await client.buildMessages(messages, parentMessageId, {
        isChatCompletion: true,
      });
      expect(result).toHaveProperty('prompt');
    });

    it('should build messages correctly for non-chat completion', async () => {
      const result = await client.buildMessages(messages, parentMessageId, {
        isChatCompletion: false,
      });
      expect(result).toHaveProperty('prompt');
    });

    it('should build messages correctly with a promptPrefix', async () => {
      const result = await client.buildMessages(messages, parentMessageId, {
        isChatCompletion: true,
        promptPrefix: 'Test Prefix',
      });
      expect(result).toHaveProperty('prompt');
      const instructions = result.prompt.find((item) => item.content.includes('Test Prefix'));
      expect(instructions).toBeDefined();
      expect(instructions.content).toContain('Test Prefix');
    });

    it('should handle context strategy correctly', async () => {
      client.contextStrategy = 'summarize';
      const result = await client.buildMessages(messages, parentMessageId, {
        isChatCompletion: true,
      });
      expect(result).toHaveProperty('prompt');
      expect(result).toHaveProperty('tokenCountMap');
    });

    it('should assign name property for user messages when options.name is set', async () => {
      client.options.name = 'Test User';
      const result = await client.buildMessages(messages, parentMessageId, {
        isChatCompletion: true,
      });
      const hasUserWithName = result.prompt.some(
        (item) => item.role === 'user' && item.name === 'Test_User',
      );
      expect(hasUserWithName).toBe(true);
    });

    it('should handle promptPrefix from options when promptPrefix argument is not provided', async () => {
      client.options.promptPrefix = 'Test Prefix from options';
      const result = await client.buildMessages(messages, parentMessageId, {
        isChatCompletion: true,
      });
      const instructions = result.prompt.find((item) =>
        item.content.includes('Test Prefix from options'),
      );
      expect(instructions.content).toContain('Test Prefix from options');
    });

    it('should handle case when neither promptPrefix argument nor options.promptPrefix is set', async () => {
      const result = await client.buildMessages(messages, parentMessageId, {
        isChatCompletion: true,
      });
      const instructions = result.prompt.find((item) => item.content.includes('Test Prefix'));
      expect(instructions).toBeUndefined();
    });

    it('should handle case when getMessagesForConversation returns null or an empty array', async () => {
      const messages = [];
      const result = await client.buildMessages(messages, parentMessageId, {
        isChatCompletion: true,
      });
      expect(result.prompt).toEqual([]);
    });
  });

  describe('getTokenCountForMessage', () => {
    const example_messages = [
      {
        role: 'system',
        content:
          'You are a helpful, pattern-following assistant that translates corporate jargon into plain English.',
      },
      {
        role: 'system',
        name: 'example_user',
        content: 'New synergies will help drive top-line growth.',
      },
      {
        role: 'system',
        name: 'example_assistant',
        content: 'Things working well together will increase revenue.',
      },
      {
        role: 'system',
        name: 'example_user',
        content:
          "Let's circle back when we have more bandwidth to touch base on opportunities for increased leverage.",
      },
      {
        role: 'system',
        name: 'example_assistant',
        content: "Let's talk later when we're less busy about how to do better.",
      },
      {
        role: 'user',
        content:
          "This late pivot means we don't have time to boil the ocean for the client deliverable.",
      },
    ];

    const testCases = [
      { model: 'gpt-3.5-turbo-0301', expected: 127 },
      { model: 'gpt-3.5-turbo-0613', expected: 129 },
      { model: 'gpt-3.5-turbo', expected: 129 },
      { model: 'gpt-4-0314', expected: 129 },
      { model: 'gpt-4-0613', expected: 129 },
      { model: 'gpt-4', expected: 129 },
      { model: 'unknown', expected: 129 },
    ];

    testCases.forEach((testCase) => {
      it(`should return ${testCase.expected} tokens for model ${testCase.model}`, () => {
        client.modelOptions.model = testCase.model;
        // 3 tokens for assistant label
        let totalTokens = 3;
        for (let message of example_messages) {
          totalTokens += client.getTokenCountForMessage(message);
        }
        expect(totalTokens).toBe(testCase.expected);
      });
    });

    const vision_request = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'describe what is in this image?',
          },
          {
            type: 'image_url',
            image_url: {
              url: 'https://venturebeat.com/wp-content/uploads/2019/03/openai-1.png',
              detail: 'high',
            },
          },
        ],
      },
    ];

    const expectedTokens = 14;
    const visionModel = 'gpt-4-vision-preview';

    it(`should return ${expectedTokens} tokens for model ${visionModel} (Vision Request)`, () => {
      client.modelOptions.model = visionModel;
      // 3 tokens for assistant label
      let totalTokens = 3;
      for (let message of vision_request) {
        totalTokens += client.getTokenCountForMessage(message);
      }
      expect(totalTokens).toBe(expectedTokens);
    });
  });

  describe('checkVisionRequest functionality', () => {
    let client;
    const attachments = [{ type: 'image/png' }];

    beforeEach(() => {
      client = new OpenAIClient('test-api-key', {
        endpoint: 'ollama',
        modelOptions: {
          model: 'initial-model',
        },
        modelsConfig: {
          ollama: ['initial-model', 'llava', 'other-model'],
        },
      });

      client.defaultVisionModel = 'non-valid-default-model';
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should set "llava" as the model if it is the first valid model when default validation fails', () => {
      client.checkVisionRequest(attachments);

      expect(client.modelOptions.model).toBe('llava');
      expect(client.isVisionModel).toBeTruthy();
      expect(client.modelOptions.stop).toBeUndefined();
    });
  });

  describe('getStreamUsage', () => {
    it('should return this.usage when completion_tokens_details is null', () => {
      const client = new OpenAIClient('test-api-key', defaultOptions);
      client.usage = {
        completion_tokens_details: null,
        prompt_tokens: 10,
        completion_tokens: 20,
      };
      client.inputTokensKey = 'prompt_tokens';
      client.outputTokensKey = 'completion_tokens';

      const result = client.getStreamUsage();

      expect(result).toEqual(client.usage);
    });

    it('should return this.usage when completion_tokens_details is missing reasoning_tokens', () => {
      const client = new OpenAIClient('test-api-key', defaultOptions);
      client.usage = {
        completion_tokens_details: {
          other_tokens: 5,
        },
        prompt_tokens: 10,
        completion_tokens: 20,
      };
      client.inputTokensKey = 'prompt_tokens';
      client.outputTokensKey = 'completion_tokens';

      const result = client.getStreamUsage();

      expect(result).toEqual(client.usage);
    });

    it('should calculate output tokens correctly when completion_tokens_details is present with reasoning_tokens', () => {
      const client = new OpenAIClient('test-api-key', defaultOptions);
      client.usage = {
        completion_tokens_details: {
          reasoning_tokens: 30,
          other_tokens: 5,
        },
        prompt_tokens: 10,
        completion_tokens: 20,
      };
      client.inputTokensKey = 'prompt_tokens';
      client.outputTokensKey = 'completion_tokens';

      const result = client.getStreamUsage();

      expect(result).toEqual({
        reasoning_tokens: 30,
        other_tokens: 5,
        prompt_tokens: 10,
        completion_tokens: 10, // |30 - 20| = 10
      });
    });

    it('should return this.usage when it is undefined', () => {
      const client = new OpenAIClient('test-api-key', defaultOptions);
      client.usage = undefined;

      const result = client.getStreamUsage();

      expect(result).toBeUndefined();
    });
  });
});
