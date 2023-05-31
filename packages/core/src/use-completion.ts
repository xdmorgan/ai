'use client'

import { useCallback, useId, useState } from 'react'
import useSWRMutation from 'swr/mutation'
import useSWR from 'swr'

const decoder = new TextDecoder()
function decodeAIStreamChunk(chunk: Uint8Array): string {
  const tokens = decoder.decode(chunk).split('\n')
  return tokens.map(t => (t ? JSON.parse(t) : '')).join('')
}

export type UseCompletionOptions = {
  /**
   * The API endpoint that accepts a `{ prompt: string }` object and returns
   * a stream of tokens of the AI completion response. Defaults to `/api/completion`.
   */
  api?: string
  /**
   * An unique identifier for the completion. If not provided, a random one will be
   * generated. When provided, the `useCompletion` hook with the same `id` will
   * have shared states across components.
   */
  id?: string
  /**
   * Initial completion result. Useful to load an existing history.
   */
  initialCompletion?: string

  /**
   * Initial prompt input of the completion.
   */
  initialInput?: string

  /**
   * HTTP headers to be sent with the API request.
   */
  headers?: Record<string, string> | Headers
  /**
   * Extra body object to be sent with the API request.
   */
  body?: any
  onResponse?: (response: Response) => void
  onCompletionEnd?: (prompt: string, completion: string) => void
}

export function useCompletion({
  api = '/api/completion',
  id,
  initialCompletion = '',
  initialInput = '',
  headers,
  body,
  onResponse,
  onCompletionEnd
}: UseCompletionOptions) {
  // Generate an unique id for the chat if not provided.
  const hookId = useId()
  const completionId = id || hookId

  // Store the chat state in SWR, using the completionId as the key to share states.
  const { data, mutate } = useSWR<string>([api, completionId], null, {
    fallbackData: initialCompletion
  })
  const completion = data!

  // Abort controller to cancel the current API call.
  const [abortController, setAbortController] =
    useState<AbortController | null>(null)

  // Actual mutation hook to send messages to the API endpoint and update the
  // chat state.
  const { error, trigger, isMutating } = useSWRMutation<
    null,
    any,
    [string, string],
    string
  >(
    [api, completionId],
    async (_, { arg: prompt }) => {
      try {
        const abortController = new AbortController()
        setAbortController(abortController)

        // Empty the completion immediately.
        mutate('', false)

        const res = await fetch(api, {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            ...body
          }),
          headers: headers || {},
          signal: abortController.signal
        }).catch(err => {
          throw err
        })

        if (onResponse) {
          try {
            await onResponse(res)
          } catch (err) {
            throw err
          }
        }

        if (!res.ok) {
          throw new Error('Failed to fetch the chat response.')
        }
        if (!res.body) {
          throw new Error('The response body is empty.')
        }

        let result = ''
        const reader = res.body.getReader()

        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }

          // Update the chat state with the new message tokens.
          result += decodeAIStreamChunk(value)
          mutate(result, false)
        }

        if (onCompletionEnd) {
          onCompletionEnd(prompt, result)
        }

        setAbortController(null)
        return null
      } catch (err) {
        // Ignore abort errors as they are expected.
        if ((err as any).name === 'AbortError') {
          setAbortController(null)
          return null
        }

        throw err
      }
    },
    {
      populateCache: false,
      revalidate: false
    }
  )

  /**
   * Abort the current API request but keep the generated tokens.
   */
  const stop = useCallback(() => {
    if (abortController) {
      abortController.abort()
      setAbortController(null)
    }
  }, [abortController])

  /**
   * Update the `completion` state locally.
   */
  const set = useCallback((completion: string) => {
    mutate(completion, false)
  }, [])

  const [input, setInput] = useState(initialInput)

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (!input) return
      trigger(input)
      setInput('')
    },
    [input]
  )

  const handleInputChange = (e: any) => {
    setInput(e.target.value)
  }

  const complete = useCallback((prompt: string) => {
    trigger(prompt)
  }, [])

  return {
    completion,
    complete,
    error,
    set,
    stop,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading: isMutating
  }
}
