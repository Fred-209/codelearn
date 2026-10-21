public class GetActivePaymentsHandler
    : IRequestHandler<GetActivePaymentsQuery, List<Guid>>
{
    private readonly IPaymentRepository _payments;

    public GetActivePaymentsHandler(IPaymentRepository payments)
        => _payments = payments;

    public async Task<List<Guid>> Handle(
        GetActivePaymentsQuery query, CancellationToken ct)
    {
        var all = await _payments.GetByAccountAsync(query.AccountId, ct);
        var settlementBatch = query.BatchId;
        return all
            .Where(p => p.Amount > 0)
            .Select(p => p.Id)
            .ToList();
    }
}

// Returns the ids of the active payments for the account.
