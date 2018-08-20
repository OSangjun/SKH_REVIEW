#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>

#define LEN_BUFFER 1000
char str[LEN_BUFFER+1];
// return length;
int convert(int m, int n) {
	int len = 0;
	int i = LEN_BUFFER - 1;
	char tmp;
	str[LEN_BUFFER] = NULL;
	if (m == 0) {
		str[i] = '0';
		return 1;
	} else {
		while (m) {
			tmp = m % n;
			tmp = tmp >= 10 ? tmp - 10 + 'A' : tmp + '0';
			str[i] = tmp;

			m = (m - m % n) / n;
			len++;	i--;
		}
	}
	return len;
}

int main() {
	// get input
	int m, n, len;
	scanf("%d %d", &m, &n);

	// convert
	len =convert(m, n);

	// ans
	printf("%s", str+LEN_BUFFER - len);


#ifdef _DEBUG
	system("pause");
#endif
	return 0;
}